from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.person_work_day import PersonWorkDay
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_months_xlsx,
)
from app.services.time_entry_service import TimeEntryService


class PayrollMonthExportService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def worker_export(
        self,
        *,
        person_id: int,
        year: int,
        month: int,
        current_user: User,
    ) -> bytes:
        person = self.db.scalar(
            select(Person)
            .options(selectinload(Person.users))
            .where(Person.id == person_id, Person.deleted_at.is_(None))
        )
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")

        period_start, period_end = payroll_month_source_range(year, month)
        entries = TimeEntryService(self.db).list_entries(
            current_user=current_user,
            person_id=person_id,
            date_from=period_start,
            date_to=period_end,
        )
        absences = self._absences(period_start, period_end, person_id=person_id)
        work_days = self._work_days(period_start, period_end, person_ids={person_id})
        return build_payroll_months_xlsx(
            [
                PayrollMonthSheet(
                    person=person,
                    sheet_name=person.display_name,
                    year=year,
                    month=month,
                    entries=entries,
                    absences=absences,
                    work_days=work_days,
                    non_working_dates=lower_saxony_public_holiday_dates(period_start, period_end),
                )
            ]
        ).content

    def all_workers_export(self, *, year: int, month: int, current_user: User) -> bytes:
        people = list(
            self.db.scalars(
                select(Person)
                .options(selectinload(Person.users))
                .where(
                    Person.is_active.is_(True),
                    Person.deleted_at.is_(None),
                    Person.person_type == PersonType.INTERNAL,
                )
                .order_by(Person.display_name.asc(), Person.id.asc())
            )
        )
        people = [person for person in people if is_payroll_review_person(person)]
        if not people:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine aktiven Monteure gefunden.")

        period_start, period_end = payroll_month_source_range(year, month)
        entries = TimeEntryService(self.db).list_entries(
            current_user=current_user,
            date_from=period_start,
            date_to=period_end,
        )
        person_ids = {person.id for person in people}
        entries_by_person: dict[int, list[WorkTimeEntry]] = defaultdict(list)
        for entry in entries:
            if entry.person_id in person_ids:
                entries_by_person[entry.person_id].append(entry)

        absences_by_person: dict[int, list[Absence]] = defaultdict(list)
        for absence in self._absences(period_start, period_end, person_ids=person_ids):
            absences_by_person[absence.person_id].append(absence)
        holidays = lower_saxony_public_holiday_dates(period_start, period_end)
        work_days_by_person: dict[int, list[PersonWorkDay]] = defaultdict(list)
        for work_day in self._work_days(period_start, period_end, person_ids=person_ids):
            work_days_by_person[work_day.person_id].append(work_day)

        return build_payroll_months_xlsx(
            [
                PayrollMonthSheet(
                    person=person,
                    sheet_name=person.display_name,
                    year=year,
                    month=month,
                    entries=entries_by_person[person.id],
                    absences=absences_by_person[person.id],
                    work_days=work_days_by_person[person.id],
                    non_working_dates=holidays,
                )
                for person in people
            ]
        ).content

    def _work_days(
        self, period_start: date, period_end: date, *, person_ids: set[int]
    ) -> list[PersonWorkDay]:
        # Auch Hotelnächte ohne Arbeitsbuchung sowie Randtage sind verbindlich.
        return list(self.db.scalars(select(PersonWorkDay).where(
            PersonWorkDay.person_id.in_(person_ids),
            PersonWorkDay.work_date >= period_start,
            PersonWorkDay.work_date <= period_end,
        )))

    def _absences(
        self,
        period_start: date,
        period_end: date,
        *,
        person_id: int | None = None,
        person_ids: set[int] | None = None,
    ) -> list[Absence]:
        statement = select(Absence).where(
            Absence.start_date <= period_end,
            Absence.end_date >= period_start,
        )
        if person_id is not None:
            statement = statement.where(Absence.person_id == person_id)
        elif person_ids is not None:
            statement = statement.where(Absence.person_id.in_(person_ids))
        return list(self.db.scalars(statement))


def is_payroll_review_person(person: Person) -> bool:
    active_roles = {user.role for user in person.users if user.is_active}
    return not active_roles or active_roles == {UserRole.MONTEUR}


def payroll_month_source_range(year: int, month: int) -> tuple[date, date]:
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    # Vollständige Randwochen plus mindestens ein Tag beiderseits des Monats:
    # Auch ein Monatsbeginn am Montag darf keine zweite Hotelanreise erzeugen.
    return (
        min(first - timedelta(days=first.weekday()), first - timedelta(days=1)),
        max(last + timedelta(days=6 - last.weekday()), last + timedelta(days=1)),
    )


def lower_saxony_public_holiday_dates(period_start: date, period_end: date) -> set[date]:
    result: set[date] = set()
    for year in range(period_start.year, period_end.year + 1):
        easter = easter_sunday(year)
        result.update(
            {
                date(year, 1, 1),
                easter - timedelta(days=2),
                easter + timedelta(days=1),
                date(year, 5, 1),
                easter + timedelta(days=39),
                easter + timedelta(days=50),
                date(year, 10, 3),
                date(year, 10, 31),
                date(year, 12, 25),
                date(year, 12, 26),
            }
        )
    return {day for day in result if period_start <= day <= period_end}


def easter_sunday(year: int) -> date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    weekday_offset = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * weekday_offset) // 451
    month = (h + weekday_offset - 7 * m + 114) // 31
    day = (h + weekday_offset - 7 * m + 114) % 31 + 1
    return date(year, month, day)
