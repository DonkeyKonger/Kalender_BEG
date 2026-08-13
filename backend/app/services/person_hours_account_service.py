from collections import defaultdict
from dataclasses import dataclass
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
ABSENCE_BREAKDOWN_ORDER = (
    AbsenceType.FREE,
    AbsenceType.VACATION,
    AbsenceType.SICK,
    AbsenceType.SCHOOL,
    AbsenceType.OTHER,
)


@dataclass(frozen=True)
class WeeklyHoursBreakdown:
    work_minutes: int
    actual_minutes: int
    absence_minutes_by_type: dict[str, int]
    overtime_absence_minutes: int
    daily_absence_credits: tuple["DailyAbsenceCredit", ...] = ()


@dataclass(frozen=True)
class DailyAbsenceCredit:
    work_date: date
    absence_type: AbsenceType
    credit_minutes: int


@dataclass(frozen=True)
class PayrollWeekPersonSummary:
    person_id: int
    work_minutes: int
    vacation_credit_minutes: int
    total_minutes: int
    vacation_days: tuple[DailyAbsenceCredit, ...]


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
        weekly_breakdown = self._weekly_actual_minutes(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
        )
        return self._book_weekly_balance(
            review=review,
            current_user=current_user,
            weekly_breakdown=weekly_breakdown,
            required_minutes=required_minutes,
        )

    def reverse_weekly_review_balance(
        self,
        *,
        review: TimeEntryWeeklyReview,
        current_user: User,
    ) -> PersonHoursAccountEntry | None:
        booked_delta = self._booked_weekly_closure_delta(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
        )
        if booked_delta == 0:
            return None
        return self._append_entry(
            person_id=review.person_id,
            entry_type=HOURS_ACCOUNT_WEEKLY,
            minutes_delta=-booked_delta,
            note=(
                f"KW {review.iso_week:02d} / {review.iso_year} zurückgesetzt: "
                "Stundenkonto-Buchung neutralisiert."
            ),
            current_user=current_user,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
            weekly_review_id=review.id,
        )

    def _book_weekly_balance(
        self,
        *,
        review: TimeEntryWeeklyReview,
        current_user: User,
        weekly_breakdown: WeeklyHoursBreakdown,
        required_minutes: int,
    ) -> PersonHoursAccountEntry | None:
        weekly_delta = weekly_breakdown.actual_minutes - required_minutes
        target_delta = weekly_delta - weekly_breakdown.overtime_absence_minutes
        booked_delta = self._booked_weekly_closure_delta(
            person_id=review.person_id,
            iso_year=review.iso_year,
            iso_week=review.iso_week,
        )
        minutes_delta = target_delta - booked_delta
        if minutes_delta == 0:
            if target_delta != 0 or self._has_weekly_closure_entry(
                person_id=review.person_id,
                iso_year=review.iso_year,
                iso_week=review.iso_week,
            ):
                return None
            note = self._weekly_balance_note(
                review=review,
                actual_minutes=weekly_breakdown.actual_minutes,
                required_minutes=required_minutes,
                overtime_absence_minutes=weekly_breakdown.overtime_absence_minutes,
            )
            return self._append_entry(
                person_id=review.person_id,
                entry_type=HOURS_ACCOUNT_WEEKLY,
                minutes_delta=0,
                note=note,
                current_user=current_user,
                iso_year=review.iso_year,
                iso_week=review.iso_week,
                weekly_review_id=review.id,
                weekly_work_minutes=weekly_breakdown.work_minutes,
                weekly_actual_minutes=weekly_breakdown.actual_minutes,
                weekly_required_minutes=required_minutes,
                weekly_overtime_absence_minutes=weekly_breakdown.overtime_absence_minutes,
                weekly_absence_breakdown=weekly_absence_breakdown_payload(weekly_breakdown.absence_minutes_by_type),
            )
        note = self._weekly_balance_note(
            review=review,
            actual_minutes=weekly_breakdown.actual_minutes,
            required_minutes=required_minutes,
            overtime_absence_minutes=weekly_breakdown.overtime_absence_minutes,
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
            weekly_work_minutes=weekly_breakdown.work_minutes,
            weekly_actual_minutes=weekly_breakdown.actual_minutes,
            weekly_required_minutes=required_minutes,
            weekly_overtime_absence_minutes=weekly_breakdown.overtime_absence_minutes,
            weekly_absence_breakdown=weekly_absence_breakdown_payload(weekly_breakdown.absence_minutes_by_type),
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
        weekly_work_minutes: int | None = None,
        weekly_actual_minutes: int | None = None,
        weekly_required_minutes: int | None = None,
        weekly_overtime_absence_minutes: int | None = None,
        weekly_absence_breakdown: list[dict[str, int | str]] | None = None,
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
            weekly_work_minutes=weekly_work_minutes,
            weekly_actual_minutes=weekly_actual_minutes,
            weekly_required_minutes=weekly_required_minutes,
            weekly_overtime_absence_minutes=weekly_overtime_absence_minutes,
            weekly_absence_breakdown=weekly_absence_breakdown,
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

    def _weekly_balance_note(
        self,
        *,
        review: TimeEntryWeeklyReview,
        actual_minutes: int,
        required_minutes: int,
        overtime_absence_minutes: int,
    ) -> str:
        weekly_delta = actual_minutes - required_minutes
        if weekly_delta == 0 and overtime_absence_minutes == 0:
            detail = "Sollzeit erreicht - keine Stundenkonto-Abweichung"
        else:
            detail = (
                f"Ist {format_minutes_as_hours(actual_minutes)} h / "
                f"Soll {format_minutes_as_hours(required_minutes)} h -> "
                f"{format_minutes_as_hours(weekly_delta)} h"
            )
            if overtime_absence_minutes:
                detail = f"{detail}; Überstundenabbau -{format_minutes_as_hours(overtime_absence_minutes)} h"
        return f"KW {review.iso_week:02d} / {review.iso_year} geprüft: {detail}"

    def _has_weekly_closure_entry(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int,
    ) -> bool:
        value = self.db.scalar(
            select(func.count(PersonHoursAccountEntry.id))
            .where(PersonHoursAccountEntry.person_id == person_id)
            .where(PersonHoursAccountEntry.entry_type.in_([HOURS_ACCOUNT_WEEKLY, HOURS_ACCOUNT_OVERTIME_ABSENCE]))
            .where(PersonHoursAccountEntry.iso_year == iso_year)
            .where(PersonHoursAccountEntry.iso_week == iso_week)
        )
        return bool(value)

    def _booked_weekly_closure_delta(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int,
    ) -> int:
        value = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0))
            .where(PersonHoursAccountEntry.person_id == person_id)
            .where(PersonHoursAccountEntry.entry_type.in_([HOURS_ACCOUNT_WEEKLY, HOURS_ACCOUNT_OVERTIME_ABSENCE]))
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

    def _weekly_actual_minutes(self, *, person_id: int, iso_year: int, iso_week: int) -> WeeklyHoursBreakdown:
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
        absences = list(
            self.db.scalars(
                select(Absence)
                .where(Absence.person_id == person_id)
                .where(Absence.status == AbsenceStatus.ACTIVE)
                .where(Absence.start_date <= end)
                .where(Absence.end_date >= start)
            )
        )
        return calculate_weekly_hours_breakdown(
            entries=entries,
            absences=absences,
            start=start,
            end=end,
        )

    def payroll_week_summaries(
        self,
        *,
        iso_year: int,
        iso_week: int,
    ) -> list[PayrollWeekPersonSummary]:
        start = date.fromisocalendar(iso_year, iso_week, 1)
        end = start + timedelta(days=6)
        entries_by_person: dict[int, list[WorkTimeEntry]] = defaultdict(list)
        for entry in self.db.scalars(
            select(WorkTimeEntry)
            .where(WorkTimeEntry.work_date >= start)
            .where(WorkTimeEntry.work_date <= end)
        ):
            entries_by_person[entry.person_id].append(entry)

        absences_by_person: dict[int, list[Absence]] = defaultdict(list)
        for absence in self.db.scalars(
            select(Absence)
            .where(Absence.status == AbsenceStatus.ACTIVE)
            .where(Absence.start_date <= end)
            .where(Absence.end_date >= start)
        ):
            absences_by_person[absence.person_id].append(absence)

        summaries: list[PayrollWeekPersonSummary] = []
        for person_id in sorted(entries_by_person.keys() | absences_by_person.keys()):
            breakdown = calculate_weekly_hours_breakdown(
                entries=entries_by_person.get(person_id, []),
                absences=absences_by_person.get(person_id, []),
                start=start,
                end=end,
            )
            vacation_days = tuple(
                credit
                for credit in breakdown.daily_absence_credits
                if credit.absence_type == AbsenceType.VACATION and credit.credit_minutes > 0
            )
            vacation_credit_minutes = sum(day.credit_minutes for day in vacation_days)
            summaries.append(
                PayrollWeekPersonSummary(
                    person_id=person_id,
                    work_minutes=breakdown.work_minutes,
                    vacation_credit_minutes=vacation_credit_minutes,
                    total_minutes=breakdown.work_minutes + vacation_credit_minutes,
                    vacation_days=vacation_days,
                )
            )
        return summaries

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
    corrected_minutes = effective_corrected_work_minutes(entry)
    if corrected_minutes is not None:
        return round_minutes_to_quarter_hour(corrected_minutes + (entry.travel_minutes or 0))
    return round_minutes_to_quarter_hour((entry.work_minutes or 0) + (entry.travel_minutes or 0))


def calculate_weekly_hours_breakdown(
    *,
    entries: list[WorkTimeEntry],
    absences: list[Absence],
    start: date,
    end: date,
) -> WeeklyHoursBreakdown:
    work_minutes_by_date: dict[date, int] = defaultdict(int)
    for entry in entries:
        if start <= entry.work_date <= end:
            work_minutes_by_date[entry.work_date] += effective_weekly_work_minutes(entry)

    absence_types_by_date: dict[date, set[AbsenceType]] = {}
    for absence in absences:
        if absence.status != AbsenceStatus.ACTIVE:
            continue
        cursor = max(absence.start_date, start)
        last_day = min(absence.end_date, end)
        while cursor <= last_day:
            if cursor.weekday() < 5:
                absence_types_by_date.setdefault(cursor, set()).add(absence.absence_type)
            cursor += timedelta(days=1)

    minutes_by_type: dict[str, int] = defaultdict(int)
    overtime_absence_minutes = 0
    overtime_absence_credit_minutes = 0
    daily_absence_credits: list[DailyAbsenceCredit] = []
    for absence_date in sorted(absence_types_by_date):
        absence_types = absence_types_by_date[absence_date]
        absence_type = primary_absence_type(absence_types)
        if absence_type is None:
            continue
        credit_minutes = max(
            0,
            ABSENCE_DAY_CREDIT_MINUTES - work_minutes_by_date.get(absence_date, 0),
        )
        daily_absence_credits.append(
            DailyAbsenceCredit(
                work_date=absence_date,
                absence_type=absence_type,
                credit_minutes=credit_minutes,
            )
        )
        if AbsenceType.FREE in absence_types:
            overtime_absence_minutes += ABSENCE_DAY_CREDIT_MINUTES
            overtime_absence_credit_minutes += credit_minutes
            continue
        if credit_minutes <= 0:
            continue
        minutes_by_type[absence_type.value] += credit_minutes

    work_minutes = sum(work_minutes_by_date.values())
    absence_credit_minutes = sum(minutes_by_type.values()) + overtime_absence_credit_minutes
    return WeeklyHoursBreakdown(
        work_minutes=work_minutes,
        actual_minutes=work_minutes + absence_credit_minutes,
        absence_minutes_by_type=dict(minutes_by_type),
        overtime_absence_minutes=overtime_absence_minutes,
        daily_absence_credits=tuple(daily_absence_credits),
    )


def effective_corrected_work_minutes(entry: WorkTimeEntry) -> int | None:
    if entry.payroll_corrected_work_minutes is not None:
        return entry.payroll_corrected_work_minutes
    corrected_break_minutes = getattr(entry, "payroll_corrected_break_minutes", None)
    return payroll_duration_minutes(
        entry.payroll_corrected_start_time,
        entry.payroll_corrected_end_time,
        corrected_break_minutes if corrected_break_minutes is not None else entry.break_minutes or 0,
    )


def duration_minutes(start_time, end_time, break_minutes: int) -> int | None:
    if start_time is None or end_time is None:
        return None
    start_minutes = start_time.hour * 60 + start_time.minute
    end_minutes = end_time.hour * 60 + end_time.minute
    if end_minutes < start_minutes:
        return None
    return max(0, end_minutes - start_minutes - (break_minutes or 0))


def payroll_duration_minutes(start_time, end_time, break_minutes: int) -> int | None:
    if start_time is None or end_time is None or start_time == end_time:
        return None
    start_minutes = start_time.hour * 60 + start_time.minute
    end_minutes = end_time.hour * 60 + end_time.minute
    gross_minutes = end_minutes - start_minutes
    if gross_minutes < 0:
        gross_minutes += 24 * 60
    net_minutes = gross_minutes - (break_minutes or 0)
    return net_minutes if net_minutes > 0 else None


def round_minutes_to_quarter_hour(minutes: int) -> int:
    return round(minutes / 15) * 15


def hours_to_minutes(hours: float) -> int:
    return int((Decimal(str(hours)) * Decimal("60")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def format_minutes_as_hours(minutes: int) -> str:
    return str((Decimal(minutes) / Decimal("60")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)).replace(".", ",")


def primary_absence_type(absence_types: set[AbsenceType]) -> AbsenceType | None:
    for absence_type in ABSENCE_BREAKDOWN_ORDER:
        if absence_type in absence_types:
            return absence_type
    return next(iter(absence_types), None)


def weekly_absence_breakdown_payload(absence_minutes_by_type: dict[str, int]) -> list[dict[str, int | str]]:
    payload: list[dict[str, int | str]] = []
    known_types = {absence_type.value for absence_type in ABSENCE_BREAKDOWN_ORDER}
    for absence_type in ABSENCE_BREAKDOWN_ORDER:
        minutes = absence_minutes_by_type.get(absence_type.value, 0)
        if minutes > 0:
            payload.append({"absence_type": absence_type.value, "minutes": minutes})
    for absence_type in sorted(set(absence_minutes_by_type) - known_types):
        minutes = absence_minutes_by_type.get(absence_type, 0)
        if minutes > 0:
            payload.append({"absence_type": absence_type, "minutes": minutes})
    return payload


def clean_required_text(value: str, message: str) -> str:
    cleaned = value.strip() if isinstance(value, str) else ""
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, message)
    return cleaned


def clean_optional_text(value: str | None) -> str | None:
    cleaned = value.strip() if isinstance(value, str) else None
    return cleaned or None
