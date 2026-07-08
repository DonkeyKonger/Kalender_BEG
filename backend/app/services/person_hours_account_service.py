from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.person_hours_account import PersonHoursAccountEntryRead, PersonHoursAccountRead


HOURS_ACCOUNT_WEEKLY = "weekly_balance"
HOURS_ACCOUNT_MANUAL = "manual_adjustment"
HOURS_ACCOUNT_PAYOUT = "payout"
HOURS_ACCOUNT_OVERTIME_ABSENCE = "overtime_absence"
OFFICE_ONLY_TIME_ENTRY_NOTE = "Büroprüfung ohne Monteur-Zeitmeldung."
ABSENCE_DAY_CREDIT_MINUTES = 8 * 60


class PersonHoursAccountService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_account(self, *, person_id: int) -> PersonHoursAccountRead:
        self._get_person(person_id)
        return PersonHoursAccountRead(
            person_id=person_id,
            current_balance_minutes=self._current_balance_minutes(person_id),
            entries=[self._entry_read(entry) for entry in self._list_entries(person_id)],
        )

    def create_manual_adjustment(
        self,
        *,
        person_id: int,
        hours_delta: float,
        note: str,
        current_user: User,
    ) -> PersonHoursAccountRead:
        self._get_person(person_id)
        minutes_delta = hours_to_minutes(hours_delta)
        if minutes_delta == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Die Korrektur muss größer oder kleiner als 0 sein.")
        cleaned_note = clean_required_text(note, "Grund ist Pflicht.")
        self._append_entry(
            person_id=person_id,
            entry_type=HOURS_ACCOUNT_MANUAL,
            minutes_delta=minutes_delta,
            note=cleaned_note,
            current_user=current_user,
        )
        self.db.commit()
        return self.get_account(person_id=person_id)

    def create_payout(
        self,
        *,
        person_id: int,
        hours: float,
        note: str | None,
        current_user: User,
    ) -> PersonHoursAccountRead:
        self._get_person(person_id)
        minutes = hours_to_minutes(hours)
        if minutes <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Auszahlung muss größer als 0 Stunden sein.")
        payout_note = clean_optional_text(note) or "Auszahlung"
        self._append_entry(
            person_id=person_id,
            entry_type=HOURS_ACCOUNT_PAYOUT,
            minutes_delta=-minutes,
            note=payout_note,
            current_user=current_user,
        )
        self.db.commit()
        return self.get_account(person_id=person_id)

    def book_weekly_review_balance(
        self,
        *,
        review: TimeEntryWeeklyReview,
        current_user: User,
    ) -> PersonHoursAccountEntry | None:
        person = self._get_person(review.person_id)
        weekly_hours = getattr(person, "weekly_hours", None)
        if weekly_hours is None:
            return None
        required_minutes = hours_to_minutes(weekly_hours)
        actual_minutes, overtime_absence_minutes = self._weekly_actual_minutes(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
        )
        weekly_entry = self._book_weekly_balance(
            review=review,
            current_user=current_user,
            actual_minutes=actual_minutes,
            required_minutes=required_minutes,
        )
        overtime_entry = self._book_overtime_absence(
            review=review,
            current_user=current_user,
            overtime_absence_minutes=overtime_absence_minutes,
        )
        return weekly_entry or overtime_entry

    def _book_weekly_balance(
        self,
        *,
        review: TimeEntryWeeklyReview,
        current_user: User,
        actual_minutes: int,
        required_minutes: int,
    ) -> PersonHoursAccountEntry | None:
        target_delta = actual_minutes - required_minutes
        booked_delta = self._booked_week_delta(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
            entry_type=HOURS_ACCOUNT_WEEKLY,
        )
        minutes_delta = target_delta - booked_delta
        if minutes_delta == 0:
            return None
        note = (
            f"KW {review.iso_week:02d} / {review.iso_year} geprüft: "
            f"Ist {format_minutes_as_hours(actual_minutes)} h / "
            f"Soll {format_minutes_as_hours(required_minutes)} h"
        )
        return self._append_entry(
            person_id=review.person_id,
            entry_type=HOURS_ACCOUNT_WEEKLY,
            minutes_delta=minutes_delta,
            note=note,
            current_user=current_user,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
            weekly_review_id=review.id,
            weekly_actual_minutes=actual_minutes,
            weekly_required_minutes=required_minutes,
        )

    def _book_overtime_absence(
        self,
        *,
        review: TimeEntryWeeklyReview,
        current_user: User,
        overtime_absence_minutes: int,
    ) -> PersonHoursAccountEntry | None:
        target_delta = -overtime_absence_minutes
        booked_delta = self._booked_week_delta(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
            entry_type=HOURS_ACCOUNT_OVERTIME_ABSENCE,
        )
        minutes_delta = target_delta - booked_delta
        if minutes_delta == 0:
            return None
        note = (
            f"Überstundenabbau KW {review.iso_week:02d} / {review.iso_year}: "
            f"{format_minutes_as_hours(overtime_absence_minutes)} h"
        )
        return self._append_entry(
            person_id=review.person_id,
            entry_type=HOURS_ACCOUNT_OVERTIME_ABSENCE,
            minutes_delta=minutes_delta,
            note=note,
            current_user=current_user,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
            weekly_review_id=review.id,
        )

    def _append_entry(
        self,
        *,
        person_id: int,
        entry_type: str,
        minutes_delta: int,
        note: str,
        current_user: User,
        iso_year: int | None = None,
        iso_week: int | None = None,
        weekly_review_id: int | None = None,
        weekly_actual_minutes: int | None = None,
        weekly_required_minutes: int | None = None,
    ) -> PersonHoursAccountEntry:
        balance_after = self._current_balance_minutes(person_id) + minutes_delta
        entry = PersonHoursAccountEntry(
            person_id=person_id,
            entry_type=entry_type,
            minutes_delta=minutes_delta,
            balance_after_minutes=balance_after,
            note=note,
            iso_year=iso_year,
            iso_week=iso_week,
            weekly_review_id=weekly_review_id,
            weekly_actual_minutes=weekly_actual_minutes,
            weekly_required_minutes=weekly_required_minutes,
            created_by_user_id=current_user.id,
        )
        self.db.add(entry)
        self.db.flush()
        return entry

    def _current_balance_minutes(self, person_id: int) -> int:
        value = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0))
            .where(PersonHoursAccountEntry.person_id == person_id)
        )
        return int(value or 0)

    def _booked_week_delta(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int,
        entry_type: str,
    ) -> int:
        value = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0))
            .where(PersonHoursAccountEntry.person_id == person_id)
            .where(PersonHoursAccountEntry.entry_type == entry_type)
            .where(PersonHoursAccountEntry.iso_year == iso_year)
            .where(PersonHoursAccountEntry.iso_week == iso_week)
        )
        return int(value or 0)

    def _list_entries(self, person_id: int) -> list[PersonHoursAccountEntry]:
        return list(
            self.db.scalars(
                select(PersonHoursAccountEntry)
                .options(selectinload(PersonHoursAccountEntry.created_by))
                .where(PersonHoursAccountEntry.person_id == person_id)
                .order_by(PersonHoursAccountEntry.created_at.desc(), PersonHoursAccountEntry.id.desc())
            )
        )

    def _weekly_actual_minutes(self, *, person_id: int, iso_year: int, iso_week: int) -> tuple[int, int]:
        start = date.fromisocalendar(iso_year, iso_week, 1)
        end = start + timedelta(days=6)
        entries = list(
            self.db.scalars(
                select(WorkTimeEntry)
                .where(WorkTimeEntry.person_id == person_id)
                .where(WorkTimeEntry.work_date >= start)
                .where(WorkTimeEntry.work_date <= end)
            )
        )
        work_minutes_by_date: dict[date, int] = {}
        for entry in entries:
            work_minutes_by_date[entry.work_date] = (
                work_minutes_by_date.get(entry.work_date, 0) + effective_weekly_work_minutes(entry)
            )
        absence_credit_minutes, overtime_absence_minutes = self._absence_week_minutes(
            person_id=person_id,
            start=start,
            end=end,
            work_minutes_by_date=work_minutes_by_date,
        )
        return sum(work_minutes_by_date.values()) + absence_credit_minutes, overtime_absence_minutes

    def _absence_week_minutes(
        self,
        *,
        person_id: int,
        start: date,
        end: date,
        work_minutes_by_date: dict[date, int],
    ) -> tuple[int, int]:
        absences = list(
            self.db.scalars(
                select(Absence)
                .where(Absence.person_id == person_id)
                .where(Absence.status == AbsenceStatus.ACTIVE)
                .where(Absence.start_date <= end)
                .where(Absence.end_date >= start)
            )
        )
        absence_dates: set[date] = set()
        overtime_absence_dates: set[date] = set()
        for absence in absences:
            cursor = max(absence.start_date, start)
            last_day = min(absence.end_date, end)
            while cursor <= last_day:
                if cursor.weekday() < 5:
                    absence_dates.add(cursor)
                    if absence.absence_type == AbsenceType.FREE:
                        overtime_absence_dates.add(cursor)
                cursor += timedelta(days=1)

        credit_by_date = {
            absence_date: max(0, ABSENCE_DAY_CREDIT_MINUTES - work_minutes_by_date.get(absence_date, 0))
            for absence_date in absence_dates
        }
        return (
            sum(credit_by_date.values()),
            sum(credit_by_date.get(absence_date, 0) for absence_date in overtime_absence_dates),
        )

    def _get_person(self, person_id: int) -> Person:
        person = self.db.get(Person, person_id)
        if person is None or getattr(person, "deleted_at", None) is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        return person

    @staticmethod
    def _entry_read(entry: PersonHoursAccountEntry) -> PersonHoursAccountEntryRead:
        return PersonHoursAccountEntryRead.model_validate(entry).model_copy(
            update={
                "created_by_name": entry.created_by.display_name if entry.created_by else None,
            }
        )


def effective_weekly_work_minutes(entry: WorkTimeEntry) -> int:
    if entry.note == OFFICE_ONLY_TIME_ENTRY_NOTE:
        return 0
    corrected_minutes = effective_corrected_work_minutes(entry)
    if corrected_minutes is not None:
        return round_minutes_to_quarter_hour(corrected_minutes + (entry.travel_minutes or 0))
    return round_minutes_to_quarter_hour((entry.work_minutes or 0) + (entry.travel_minutes or 0))


def effective_corrected_work_minutes(entry: WorkTimeEntry) -> int | None:
    if entry.payroll_corrected_work_minutes is not None:
        return entry.payroll_corrected_work_minutes
    return duration_minutes(
        entry.payroll_corrected_start_time,
        entry.payroll_corrected_end_time,
        entry.break_minutes or 0,
    )


def duration_minutes(start_time, end_time, break_minutes: int) -> int | None:
    if start_time is None or end_time is None:
        return None
    start_minutes = start_time.hour * 60 + start_time.minute
    end_minutes = end_time.hour * 60 + end_time.minute
    if end_minutes < start_minutes:
        return None
    return max(0, end_minutes - start_minutes - (break_minutes or 0))


def round_minutes_to_quarter_hour(minutes: int) -> int:
    return round(minutes / 15) * 15


def hours_to_minutes(hours: float) -> int:
    return int((Decimal(str(hours)) * Decimal("60")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def format_minutes_as_hours(minutes: int) -> str:
    return str((Decimal(minutes) / Decimal("60")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)).replace(".", ",")


def clean_required_text(value: str, message: str) -> str:
    cleaned = value.strip() if isinstance(value, str) else ""
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, message)
    return cleaned


def clean_optional_text(value: str | None) -> str | None:
    cleaned = value.strip() if isinstance(value, str) else None
    return cleaned or None
