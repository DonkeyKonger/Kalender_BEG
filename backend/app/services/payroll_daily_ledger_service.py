from __future__ import annotations

import calendar
import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.payroll_daily_ledger import (
    PAYROLL_LEDGER_CUTOVER_DATE,
    PAYROLL_LEDGER_OPENING_DATE,
    PersonHoursOpeningBalance,
    PersonWeeklySchedule,
)
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.payroll_setup import (
    PayrollOpeningBalanceRead,
    PayrollOpeningBalanceUpsert,
    PayrollSetupRead,
    PayrollSetupWorkerRead,
    PayrollWeeklyPlanRead,
    PayrollWeeklyPlanUpsert,
)
from app.services.person_hours_account_service import effective_weekly_work_minutes
from app.services.payroll_period_guard import PayrollPeriodGuard


CUTOVER_DATE = PAYROLL_LEDGER_CUTOVER_DATE
LEGACY_OPENING_DATE = PAYROLL_LEDGER_OPENING_DATE
LEDGER_SYSTEM_LEGACY = "legacy"
LEDGER_SYSTEM_DAILY = "daily"
ENTRY_TYPE_DAILY_BALANCE = "daily_balance"
ENTRY_TYPE_MANUAL_ADJUSTMENT = "manual_adjustment"
ENTRY_TYPE_PAYOUT = "payout"
SUPPORTED_CREDIT_ABSENCES = {
    AbsenceType.VACATION,
    AbsenceType.SICK,
    AbsenceType.SCHOOL,
}
PAYROLL_SETUP_ADVISORY_LOCK_KEY = 5_259_609


@dataclass(frozen=True)
class PayrollLedgerBlocker:
    code: str
    message: str
    person_id: int | None = None
    work_date: date | None = None
    work_date_end: date | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": self.message,
            "person_id": self.person_id,
            "work_date": self.work_date.isoformat() if self.work_date else None,
            "work_date_end": self.work_date_end.isoformat() if self.work_date_end else None,
        }


@dataclass(frozen=True)
class MonthReadiness:
    year: int
    month: int
    period_start: date
    period_end: date
    blockers: tuple[PayrollLedgerBlocker, ...]

    @property
    def is_ready(self) -> bool:
        return not self.blockers

    @property
    def issues(self) -> tuple[PayrollLedgerBlocker, ...]:
        return self.blockers


@dataclass(frozen=True)
class PayrollDayLedgerValue:
    person_id: int
    work_date: date
    schedule_id: int
    target_minutes: int
    work_minutes: int
    credit_minutes: int
    actual_minutes: int
    movement_minutes: int
    other_movement_minutes: int
    absence_type: str | None
    is_public_holiday: bool
    work_entry_ids: tuple[int, ...]
    absence_ids: tuple[int, ...]
    source_fingerprint: str
    ledger_entry_id: int | None = None

    @property
    def total_movement_minutes(self) -> int:
        return self.movement_minutes + self.other_movement_minutes

    def to_payload(self) -> dict[str, object]:
        return {
            "work_date": self.work_date.isoformat(),
            "schedule_id": self.schedule_id,
            "target_minutes": self.target_minutes,
            "work_minutes": self.work_minutes,
            "credit_minutes": self.credit_minutes,
            "actual_minutes": self.actual_minutes,
            "movement_minutes": self.movement_minutes,
            "other_movement_minutes": self.other_movement_minutes,
            "total_movement_minutes": self.total_movement_minutes,
            "absence_type": self.absence_type,
            "is_public_holiday": self.is_public_holiday,
            "work_entry_ids": list(self.work_entry_ids),
            "absence_ids": list(self.absence_ids),
            "source_fingerprint": self.source_fingerprint,
            "ledger_entry_id": self.ledger_entry_id,
        }


@dataclass(frozen=True)
class PersonMonthLedgerResult:
    person_id: int
    person_name: str
    opening_balance_minutes: int
    movement_minutes: int
    closing_balance_minutes: int
    days: tuple[PayrollDayLedgerValue, ...]

    @property
    def daily_values(self) -> tuple[dict[str, object], ...]:
        return tuple(day.to_payload() for day in self.days)

    def to_payload(self) -> dict[str, object]:
        return {
            "person_id": self.person_id,
            "person_name": self.person_name,
            "opening_balance_minutes": self.opening_balance_minutes,
            "movement_minutes": self.movement_minutes,
            "closing_balance_minutes": self.closing_balance_minutes,
            "days": list(self.daily_values),
        }


@dataclass(frozen=True)
class MonthLedgerFinalization:
    year: int
    month: int
    period_start: date
    period_end: date
    source: str
    reference_id: str
    people: tuple[PersonMonthLedgerResult, ...]

    def to_payload(self) -> dict[str, object]:
        return {
            "year": self.year,
            "month": self.month,
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "source": self.source,
            "reference_id": self.reference_id,
            "people": [person.to_payload() for person in self.people],
        }


class PayrollLedgerValidationError(ValueError):
    def __init__(self, blockers: tuple[PayrollLedgerBlocker, ...] | list[PayrollLedgerBlocker]):
        self.blockers = tuple(blockers)
        super().__init__("; ".join(blocker.message for blocker in self.blockers))


class PayrollSetupValidationError(ValueError):
    pass


class PayrollDailyLedgerService:
    """Cutover-safe payroll ledger foundation.

    Mutating methods only flush.  Transaction ownership, authorization, month
    locking and audit records stay with the API/month-close orchestration layer.
    """

    def __init__(self, db: Session) -> None:
        self.db = db

    def setup_status(self, *, effective_date: date = CUTOVER_DATE) -> PayrollSetupRead:
        people = self._active_payroll_people()
        schedules = self._schedules_for_people({person.id for person in people})
        openings = self._openings_for_people({person.id for person in people})
        workers: list[PayrollSetupWorkerRead] = []
        for person in people:
            matching = [
                schedule
                for schedule in schedules.get(person.id, ())
                if schedule.valid_from <= effective_date
                and (schedule.valid_until is None or schedule.valid_until >= effective_date)
            ]
            plan = matching[0] if len(matching) == 1 else None
            opening = openings.get(person.id)
            workers.append(
                PayrollSetupWorkerRead(
                    person_id=person.id,
                    person_name=person.display_name,
                    weekly_hours=person.weekly_hours,
                    plan=self.schedule_read(plan) if plan else None,
                    opening_balance=self.opening_read(opening) if opening else None,
                    historical_balance_minutes=self.legacy_balance_minutes(person.id),
                )
            )
        is_ready = bool(workers) and all(
            worker.plan is not None
            and worker.plan.is_confirmed
            and worker.opening_balance is not None
            and worker.opening_balance.is_confirmed
            for worker in workers
        )
        return PayrollSetupRead(
            effective_date=effective_date,
            is_ready=is_ready,
            workers=workers,
        )

    def weekly_schedules_for_person(self, person_id: int) -> list[PayrollWeeklyPlanRead]:
        person = self.db.scalar(
            select(Person).where(Person.id == person_id, Person.deleted_at.is_(None))
        )
        if person is None:
            raise PayrollSetupValidationError("Person nicht gefunden.")
        if person.person_type != PersonType.INTERNAL:
            raise PayrollSetupValidationError(
                "Regelmäßige Arbeitszeit kann nur für eigene Mitarbeiter gepflegt werden."
            )
        schedules = self._schedules_for_people({person_id}).get(person_id, ())
        return [self.schedule_read(schedule) for schedule in schedules]

    def is_process_active(self) -> bool:
        """True after complete setup or after the first persisted daily close.

        This keeps the existing weekly calculation available during controlled
        setup, but never falls back to it after the new ledger has started.
        """

        daily_entry_exists = self.db.scalar(
            select(func.count(PersonHoursAccountEntry.id)).where(
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
            )
        )
        return bool(daily_entry_exists) or self.setup_status(effective_date=CUTOVER_DATE).is_ready

    def has_day_entries_for_source(self, *, source: str, reference_id: str) -> bool:
        value = self.db.scalar(
            select(func.count(PersonHoursAccountEntry.id)).where(
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
                PersonHoursAccountEntry.source_type == source,
                PersonHoursAccountEntry.source_reference_id == reference_id,
            )
        )
        return bool(value)

    def upsert_weekly_schedule(
        self,
        *,
        person_id: int,
        payload: PayrollWeeklyPlanUpsert,
        current_user: User,
    ) -> PersonWeeklySchedule:
        # Keep the same lock order as month close: global setup/close lock,
        # affected month lock, then person row. This avoids a close-vs-plan
        # deadlock while serializing concurrent plan versions.
        self._acquire_setup_lock()
        guard = PayrollPeriodGuard(self.db)
        if payload.valid_to is None:
            guard.assert_open_ended_range_mutable(payload.valid_from, person_id=person_id)
        else:
            guard.assert_range_mutable(payload.valid_from, payload.valid_to, person_id=person_id)
        person = self._lock_person(person_id)
        values = tuple(payload.weekday_minutes)
        weekly_total = sum(values)
        contract_minutes = _contract_weekly_minutes(person.weekly_hours)
        if payload.confirm:
            if contract_minutes is None:
                raise PayrollSetupValidationError(
                    "Im Monteursstamm fehlen die vertraglichen Wochenstunden."
                )
            if weekly_total != contract_minutes:
                raise PayrollSetupValidationError(
                    "Die Wochensumme des Plans stimmt nicht mit den hinterlegten "
                    "Wochenstunden überein."
                )

        schedules = list(
            self.db.scalars(
                select(PersonWeeklySchedule)
                .where(PersonWeeklySchedule.person_id == person_id)
                .order_by(PersonWeeklySchedule.valid_from)
            )
        )
        same_start = next(
            (schedule for schedule in schedules if schedule.valid_from == payload.valid_from),
            None,
        )
        if same_start is not None and same_start.is_confirmed:
            if self._schedule_matches_payload(same_start, payload):
                return same_start
            raise PayrollSetupValidationError(
                "Ein bestätigter Wochenplan ist unveränderlich. Legen Sie eine neue Version an."
            )

        valid_to = payload.valid_to
        predecessor_candidates = [
            schedule
            for schedule in schedules
            if schedule is not same_start
            and schedule.valid_from < payload.valid_from
            and schedule.valid_until is None
        ]
        if len(predecessor_candidates) > 1:
            raise PayrollSetupValidationError(
                "Die vorhandenen Wochenpläne sind nicht eindeutig und müssen geprüft werden."
            )
        predecessor = predecessor_candidates[0] if predecessor_candidates else None
        for schedule in schedules:
            if schedule is same_start:
                continue
            compared_end = (
                payload.valid_from - timedelta(days=1)
                if schedule is predecessor
                else schedule.valid_until
            )
            if _date_ranges_overlap(
                payload.valid_from,
                valid_to,
                schedule.valid_from,
                compared_end,
            ):
                raise PayrollSetupValidationError(
                    "Der neue Wochenplan überschneidet sich mit einem bestehenden Plan."
                )

        if predecessor is not None:
            predecessor.valid_until = payload.valid_from - timedelta(days=1)

        now = datetime.now(timezone.utc)
        schedule = same_start or PersonWeeklySchedule(
            person_id=person_id,
            valid_from=payload.valid_from,
            created_by_user_id=current_user.id,
        )
        (
            schedule.monday_minutes,
            schedule.tuesday_minutes,
            schedule.wednesday_minutes,
            schedule.thursday_minutes,
            schedule.friday_minutes,
            schedule.saturday_minutes,
            schedule.sunday_minutes,
        ) = values
        schedule.valid_until = valid_to
        schedule.weekly_total_minutes = weekly_total
        schedule.contract_weekly_minutes = contract_minutes if payload.confirm else None
        schedule.note = payload.note
        schedule.is_confirmed = payload.confirm
        schedule.confirmed_by_user_id = current_user.id if payload.confirm else None
        schedule.confirmed_at = now if payload.confirm else None
        if same_start is None:
            self.db.add(schedule)
        self.db.flush()
        return schedule

    def upsert_opening_balance(
        self,
        *,
        person_id: int,
        payload: PayrollOpeningBalanceUpsert,
        current_user: User,
    ) -> PersonHoursOpeningBalance:
        self._acquire_setup_lock()
        self._lock_person(person_id)
        opening = self.db.scalar(
            select(PersonHoursOpeningBalance).where(
                PersonHoursOpeningBalance.person_id == person_id,
                PersonHoursOpeningBalance.as_of_date == LEGACY_OPENING_DATE,
            )
        )
        if opening is not None and opening.is_confirmed:
            if (
                opening.balance_minutes == payload.minutes
                and opening.note == payload.note
                and payload.confirm
            ):
                return opening
            raise PayrollSetupValidationError(
                "Ein bestätigter Eröffnungssaldo ist unveränderlich."
            )
        now = datetime.now(timezone.utc)
        if opening is None:
            opening = PersonHoursOpeningBalance(
                person_id=person_id,
                as_of_date=LEGACY_OPENING_DATE,
                balance_minutes=payload.minutes,
                created_by_user_id=current_user.id,
            )
            self.db.add(opening)
        else:
            opening.balance_minutes = payload.minutes
        opening.note = payload.note
        opening.is_confirmed = payload.confirm
        opening.confirmed_by_user_id = current_user.id if payload.confirm else None
        opening.confirmed_at = now if payload.confirm else None
        self.db.flush()
        if payload.confirm:
            self.recalculate_balance_history(person_id)
        return opening

    def validate_month_readiness(self, year: int, month: int) -> MonthReadiness:
        period_start, period_end = _month_range(year, month)
        people = self._active_payroll_people()
        prepared, blockers = self._prepare_days(
            people=people,
            period_start=period_start,
            period_end=period_end,
        )
        blockers.extend(
            self._stale_daily_entry_blockers(
                prepared=prepared,
                period_start=period_start,
                period_end=period_end,
            )
        )
        blockers = self._group_missing_schedule_blockers(blockers, people)
        return MonthReadiness(
            year=year,
            month=month,
            period_start=period_start,
            period_end=period_end,
            blockers=tuple(blockers),
        )

    @staticmethod
    def _group_missing_schedule_blockers(
        blockers: list[PayrollLedgerBlocker],
        people: list[Person],
    ) -> list[PayrollLedgerBlocker]:
        """Collapse daily schedule gaps into one actionable range per worker."""

        people_by_id = {person.id: person for person in people}
        missing_by_person: dict[int, list[date]] = defaultdict(list)
        other: list[PayrollLedgerBlocker] = []
        for blocker in blockers:
            if (
                blocker.code == "schedule_missing"
                and blocker.person_id is not None
                and blocker.work_date is not None
            ):
                missing_by_person[blocker.person_id].append(blocker.work_date)
            else:
                other.append(blocker)

        grouped: list[PayrollLedgerBlocker] = []
        for person_id, missing_dates in sorted(missing_by_person.items()):
            person = people_by_id.get(person_id)
            weekly_hours = _format_weekly_hours(person.weekly_hours if person else None)
            person_name = person.display_name if person else f"Mitarbeiter {person_id}"
            ordered_dates = sorted(set(missing_dates))
            range_start = ordered_dates[0]
            range_end = range_start
            for missing_date in ordered_dates[1:] + [None]:
                if missing_date is not None and missing_date == range_end + timedelta(days=1):
                    range_end = missing_date
                    continue
                period_label = _format_date_range(range_start, range_end)
                grouped.append(PayrollLedgerBlocker(
                    code="schedule_missing",
                    message=(
                        f"Für {person_name} ist noch nicht festgelegt, an welchen Wochentagen "
                        f"die {weekly_hours} vertraglichen Wochenstunden gelten. Deshalb können "
                        f"Sollstunden und Stundenkonto für {period_label} nicht berechnet werden."
                    ),
                    person_id=person_id,
                    work_date=range_start,
                    work_date_end=range_end,
                ))
                if missing_date is not None:
                    range_start = missing_date
                    range_end = missing_date
        return other + grouped

    def finalize_month(
        self,
        year: int,
        month: int,
        source: str,
        reference_id: str,
        *,
        created_by_user_id: int | None = None,
    ) -> MonthLedgerFinalization:
        period_start, period_end = _month_range(year, month)
        return self._finalize_range(
            people=self._active_payroll_people(lock=True),
            period_start=period_start,
            period_end=period_end,
            source=source,
            reference_id=reference_id,
            created_by_user_id=created_by_user_id,
            result_year=year,
            result_month=month,
        )

    def finalize_person_days(
        self,
        *,
        person_id: int,
        period_start: date,
        period_end: date,
        source: str,
        reference_id: str,
        created_by_user_id: int | None = None,
    ) -> tuple[PayrollDayLedgerValue, ...]:
        if period_end < period_start:
            raise ValueError("Das Enddatum liegt vor dem Startdatum.")
        person = self._lock_person(person_id)
        result = self._finalize_range(
            people=[person],
            period_start=max(period_start, CUTOVER_DATE),
            period_end=period_end,
            source=source,
            reference_id=reference_id,
            created_by_user_id=created_by_user_id,
            result_year=period_start.year,
            result_month=period_start.month,
        )
        return result.people[0].days

    def unfinalize_month(
        self,
        year: int,
        month: int,
        source: str,
        reference_id: str,
        *,
        superseded_at: datetime | None = None,
    ) -> int:
        """Deactivate all day balances in a reopened month; never delete history."""

        _validate_source(source, reference_id)
        period_start, period_end = _month_range(year, month)
        entries = list(
            self.db.scalars(
                select(PersonHoursAccountEntry)
                .where(
                    PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                    PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
                    PersonHoursAccountEntry.is_active.is_(True),
                    PersonHoursAccountEntry.effective_date >= period_start,
                    PersonHoursAccountEntry.effective_date <= period_end,
                )
                .with_for_update()
            )
        )
        timestamp = superseded_at or datetime.now(timezone.utc)
        for entry in entries:
            entry.is_active = False
            entry.superseded_at = timestamp
            payload = dict(entry.source_payload or {})
            payload["superseded_by"] = {
                "source": source,
                "reference_id": reference_id,
                "at": timestamp.isoformat(),
            }
            entry.source_payload = payload
        self.db.flush()
        for person_id in sorted({entry.person_id for entry in entries}):
            self.recalculate_balance_history(person_id)
        return len(entries)

    def unfinalize_person_days(
        self,
        *,
        person_id: int,
        period_start: date,
        period_end: date,
        source: str,
        reference_id: str,
    ) -> int:
        entries = list(
            self.db.scalars(
                select(PersonHoursAccountEntry)
                .where(
                    PersonHoursAccountEntry.person_id == person_id,
                    PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                    PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
                    PersonHoursAccountEntry.source_type == source,
                    PersonHoursAccountEntry.source_reference_id == reference_id,
                    PersonHoursAccountEntry.is_active.is_(True),
                    PersonHoursAccountEntry.effective_date >= period_start,
                    PersonHoursAccountEntry.effective_date <= period_end,
                )
                .with_for_update()
            )
        )
        timestamp = datetime.now(timezone.utc)
        for entry in entries:
            entry.is_active = False
            entry.superseded_at = timestamp
        self.db.flush()
        if entries:
            self.recalculate_balance_history(person_id)
        return len(entries)

    def legacy_balance_minutes(self, person_id: int) -> int:
        value = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0)).where(
                PersonHoursAccountEntry.person_id == person_id,
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_LEGACY,
                PersonHoursAccountEntry.is_active.is_(True),
            )
        )
        return int(value or 0)

    def current_balance_minutes(self, person_id: int) -> int:
        opening = self._confirmed_opening(person_id)
        daily_value = self._daily_movement_minutes(person_id)
        if opening is None:
            # Compatibility before a worker's cutover setup is confirmed.  The
            # month-close readiness gate still prevents productive activation.
            return self.legacy_balance_minutes(person_id) + daily_value
        return opening.balance_minutes + daily_value

    def balance_before(self, person_id: int, boundary: date) -> int:
        opening = self._confirmed_opening(person_id)
        if opening is None:
            raise PayrollSetupValidationError(
                "Für den Monteur fehlt ein bestätigter Eröffnungssaldo."
            )
        movement = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0)).where(
                PersonHoursAccountEntry.person_id == person_id,
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.is_active.is_(True),
                PersonHoursAccountEntry.effective_date >= CUTOVER_DATE,
                PersonHoursAccountEntry.effective_date < boundary,
            )
        )
        return opening.balance_minutes + int(movement or 0)

    def recalculate_balance_history(self, person_id: int) -> int:
        """Refresh derived running balances in effective-date order."""

        opening = self._confirmed_opening(person_id)
        running = (
            opening.balance_minutes
            if opening is not None
            else self.legacy_balance_minutes(person_id)
        )
        entries = list(self.db.scalars(
            select(PersonHoursAccountEntry)
            .where(
                PersonHoursAccountEntry.person_id == person_id,
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.is_active.is_(True),
                PersonHoursAccountEntry.effective_date >= CUTOVER_DATE,
            )
            .order_by(
                PersonHoursAccountEntry.effective_date,
                PersonHoursAccountEntry.created_at,
                PersonHoursAccountEntry.id,
            )
            .with_for_update()
        ))
        for entry in entries:
            running += entry.minutes_delta
            entry.balance_after_minutes = running
        self.db.flush()
        return running

    def _finalize_range(
        self,
        *,
        people: list[Person],
        period_start: date,
        period_end: date,
        source: str,
        reference_id: str,
        created_by_user_id: int | None,
        result_year: int,
        result_month: int,
    ) -> MonthLedgerFinalization:
        _validate_source(source, reference_id)
        if period_start < CUTOVER_DATE:
            raise PayrollLedgerValidationError([
                PayrollLedgerBlocker(
                    code="before_cutover",
                    message="Das tageweise Stundenkonto beginnt am 01.08.2026.",
                    work_date=period_start,
                )
            ])
        prepared, blockers = self._prepare_days(
            people=people,
            period_start=period_start,
            period_end=period_end,
        )
        blockers.extend(
            self._stale_daily_entry_blockers(
                prepared=prepared,
                period_start=period_start,
                period_end=period_end,
            )
        )
        if blockers:
            raise PayrollLedgerValidationError(blockers)

        active_entries = self._active_daily_entries(period_start, period_end)
        active_by_person_date = {
            (entry.person_id, entry.effective_date): entry for entry in active_entries
        }
        finalized_days: dict[int, list[PayrollDayLedgerValue]] = defaultdict(list)
        for person in people:
            for day in prepared[person.id]:
                entry = active_by_person_date.get((person.id, day.work_date))
                if entry is None:
                    idempotency_key = _daily_idempotency_key(
                        source=source,
                        reference_id=reference_id,
                        person_id=person.id,
                        work_date=day.work_date,
                    )
                    prior = self.db.scalar(
                        select(PersonHoursAccountEntry).where(
                            PersonHoursAccountEntry.idempotency_key == idempotency_key
                        )
                    )
                    if prior is not None:
                        raise PayrollLedgerValidationError([
                            PayrollLedgerBlocker(
                                code="finalization_reference_reused",
                                message=(
                                    "Die Abschlussreferenz wurde bereits verwendet. "
                                    "Ein erneuter Abschluss benötigt eine neue Version."
                                ),
                                person_id=person.id,
                                work_date=day.work_date,
                            )
                        ])
                    entry = PersonHoursAccountEntry(
                        person_id=person.id,
                        entry_type=ENTRY_TYPE_DAILY_BALANCE,
                        minutes_delta=day.movement_minutes,
                        # Recomputed in effective-date order after all rows exist.
                        balance_after_minutes=0,
                        note=f"Tagesabschluss {day.work_date.strftime('%d.%m.%Y')}",
                        created_by_user_id=created_by_user_id,
                        ledger_system=LEDGER_SYSTEM_DAILY,
                        effective_date=day.work_date,
                        source_type=source,
                        source_reference_id=reference_id,
                        idempotency_key=idempotency_key,
                        is_active=True,
                        daily_target_minutes=day.target_minutes,
                        daily_work_minutes=day.work_minutes,
                        daily_credit_minutes=day.credit_minutes,
                        daily_actual_minutes=day.actual_minutes,
                        daily_absence_type=day.absence_type,
                        source_fingerprint=day.source_fingerprint,
                        source_payload=_day_source_payload(day),
                    )
                    self.db.add(entry)
                    self.db.flush()
                finalized_days[person.id].append(replace(day, ledger_entry_id=entry.id))

        for person in people:
            self.recalculate_balance_history(person.id)

        results: list[PersonMonthLedgerResult] = []
        for person in people:
            opening = self.balance_before(person.id, period_start)
            entries = self._active_new_entries_for_person(
                person_id=person.id,
                period_start=period_start,
                period_end=period_end,
            )
            movement = sum(entry.minutes_delta for entry in entries)
            other_by_date: dict[date, int] = defaultdict(int)
            for entry in entries:
                if entry.entry_type != ENTRY_TYPE_DAILY_BALANCE and entry.effective_date is not None:
                    other_by_date[entry.effective_date] += entry.minutes_delta
            days = tuple(
                replace(day, other_movement_minutes=other_by_date.get(day.work_date, 0))
                for day in finalized_days[person.id]
            )
            results.append(
                PersonMonthLedgerResult(
                    person_id=person.id,
                    person_name=person.display_name,
                    opening_balance_minutes=opening,
                    movement_minutes=movement,
                    closing_balance_minutes=opening + movement,
                    days=days,
                )
            )
        self.db.flush()
        return MonthLedgerFinalization(
            year=result_year,
            month=result_month,
            period_start=period_start,
            period_end=period_end,
            source=source,
            reference_id=reference_id,
            people=tuple(results),
        )

    def _prepare_days(
        self,
        *,
        people: list[Person],
        period_start: date,
        period_end: date,
    ) -> tuple[dict[int, tuple[PayrollDayLedgerValue, ...]], list[PayrollLedgerBlocker]]:
        blockers: list[PayrollLedgerBlocker] = []
        if period_start < CUTOVER_DATE:
            blockers.append(PayrollLedgerBlocker(
                code="before_cutover",
                message="Das tageweise Stundenkonto beginnt am 01.08.2026.",
                work_date=period_start,
            ))
            return {}, blockers
        person_ids = {person.id for person in people}
        if not people:
            blockers.append(PayrollLedgerBlocker(
                code="no_payroll_workers",
                message="Es wurden keine aktiven Monteure gefunden.",
            ))
            return {}, blockers
        schedules = self._schedules_for_people(person_ids, period_start, period_end)
        openings = self._openings_for_people(person_ids)
        entries_by_person_date: dict[tuple[int, date], list[WorkTimeEntry]] = defaultdict(list)
        for entry in self.db.scalars(
            select(WorkTimeEntry).where(
                WorkTimeEntry.person_id.in_(person_ids),
                WorkTimeEntry.work_date >= period_start,
                WorkTimeEntry.work_date <= period_end,
            )
        ):
            entries_by_person_date[(entry.person_id, entry.work_date)].append(entry)
        absences_by_person_date: dict[tuple[int, date], list[Absence]] = defaultdict(list)
        for absence in self.db.scalars(
            select(Absence).where(
                Absence.person_id.in_(person_ids),
                Absence.status == AbsenceStatus.ACTIVE,
                Absence.start_date <= period_end,
                Absence.end_date >= period_start,
            )
        ):
            cursor = max(absence.start_date, period_start)
            last = min(absence.end_date, period_end)
            while cursor <= last:
                absences_by_person_date[(absence.person_id, cursor)].append(absence)
                cursor += timedelta(days=1)
        public_holidays = lower_saxony_public_holidays(period_start, period_end)

        prepared: dict[int, tuple[PayrollDayLedgerValue, ...]] = {}
        for person in people:
            opening = openings.get(person.id)
            if opening is None or not opening.is_confirmed:
                blockers.append(PayrollLedgerBlocker(
                    code="opening_balance_missing",
                    message="Der bestätigte Legacy-Eröffnungssaldo fehlt.",
                    person_id=person.id,
                ))
            person_days: list[PayrollDayLedgerValue] = []
            for work_date in _date_range(period_start, period_end):
                matching_schedules = [
                    schedule
                    for schedule in schedules.get(person.id, ())
                    if schedule.valid_from <= work_date
                    and (schedule.valid_until is None or schedule.valid_until >= work_date)
                ]
                if len(matching_schedules) != 1:
                    blockers.append(PayrollLedgerBlocker(
                        code=(
                            "schedule_missing" if not matching_schedules else "schedule_overlap"
                        ),
                        message=(
                            "Für diesen Tag fehlt ein eindeutiger Wochenplan."
                            if not matching_schedules
                            else "Für diesen Tag gelten mehrere Wochenpläne."
                        ),
                        person_id=person.id,
                        work_date=work_date,
                    ))
                    continue
                schedule = matching_schedules[0]
                if not schedule.is_confirmed:
                    blockers.append(PayrollLedgerBlocker(
                        code="schedule_unconfirmed",
                        message="Der für diesen Tag gültige Wochenplan ist nicht bestätigt.",
                        person_id=person.id,
                        work_date=work_date,
                    ))
                    continue
                if (
                    schedule.contract_weekly_minutes is None
                    or schedule.weekly_total_minutes != schedule.contract_weekly_minutes
                ):
                    blockers.append(PayrollLedgerBlocker(
                        code="schedule_contract_mismatch",
                        message=(
                            "Die Wochensumme des Plans stimmt nicht mit der bei Bestätigung "
                            "hinterlegten Vertragszeit überein."
                        ),
                        person_id=person.id,
                        work_date=work_date,
                    ))
                    continue
                value, day_blockers = _calculate_day_value(
                    person_id=person.id,
                    work_date=work_date,
                    schedule=schedule,
                    entries=entries_by_person_date.get((person.id, work_date), []),
                    absences=absences_by_person_date.get((person.id, work_date), []),
                    is_public_holiday=work_date in public_holidays,
                )
                blockers.extend(day_blockers)
                if value is not None:
                    person_days.append(value)
            prepared[person.id] = tuple(person_days)
        return prepared, blockers

    def _stale_daily_entry_blockers(
        self,
        *,
        prepared: dict[int, tuple[PayrollDayLedgerValue, ...]],
        period_start: date,
        period_end: date,
    ) -> list[PayrollLedgerBlocker]:
        expected = {
            (day.person_id, day.work_date): day
            for person_days in prepared.values()
            for day in person_days
        }
        blockers: list[PayrollLedgerBlocker] = []
        for entry in self._active_daily_entries(period_start, period_end):
            if entry.effective_date is None:
                blockers.append(PayrollLedgerBlocker(
                    code="daily_entry_without_date",
                    message="Eine aktive Tagesbuchung besitzt kein Wirksamkeitsdatum.",
                    person_id=entry.person_id,
                ))
                continue
            day = expected.get((entry.person_id, entry.effective_date))
            if day is None or entry.source_fingerprint != day.source_fingerprint:
                blockers.append(PayrollLedgerBlocker(
                    code="finalized_day_changed",
                    message=(
                        "Die Quelldaten eines bereits finalisierten Tages haben sich geändert. "
                        "Die bestehende Finalisierung muss zuerst aufgehoben werden."
                    ),
                    person_id=entry.person_id,
                    work_date=entry.effective_date,
                ))
        return blockers

    def _active_daily_entries(
        self, period_start: date, period_end: date
    ) -> list[PersonHoursAccountEntry]:
        return list(self.db.scalars(
            select(PersonHoursAccountEntry).where(
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
                PersonHoursAccountEntry.is_active.is_(True),
                PersonHoursAccountEntry.effective_date >= period_start,
                PersonHoursAccountEntry.effective_date <= period_end,
            )
        ))

    def _active_new_entries_for_person(
        self, *, person_id: int, period_start: date, period_end: date
    ) -> list[PersonHoursAccountEntry]:
        return list(self.db.scalars(
            select(PersonHoursAccountEntry).where(
                PersonHoursAccountEntry.person_id == person_id,
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.is_active.is_(True),
                PersonHoursAccountEntry.effective_date >= period_start,
                PersonHoursAccountEntry.effective_date <= period_end,
            )
        ))

    def _daily_movement_minutes(self, person_id: int) -> int:
        value = self.db.scalar(
            select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0)).where(
                PersonHoursAccountEntry.person_id == person_id,
                PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
                PersonHoursAccountEntry.is_active.is_(True),
                PersonHoursAccountEntry.effective_date >= CUTOVER_DATE,
            )
        )
        return int(value or 0)

    def _confirmed_opening(self, person_id: int) -> PersonHoursOpeningBalance | None:
        return self.db.scalar(
            select(PersonHoursOpeningBalance).where(
                PersonHoursOpeningBalance.person_id == person_id,
                PersonHoursOpeningBalance.as_of_date == LEGACY_OPENING_DATE,
                PersonHoursOpeningBalance.is_confirmed.is_(True),
            )
        )

    def _active_payroll_people(self, *, lock: bool = False) -> list[Person]:
        statement = (
            select(Person)
            .options(selectinload(Person.users))
            .where(
                Person.is_active.is_(True),
                Person.deleted_at.is_(None),
                Person.person_type == PersonType.INTERNAL,
            )
            .order_by(Person.display_name, Person.id)
        )
        if lock:
            statement = statement.with_for_update()
        people = list(self.db.scalars(statement).unique())
        return [person for person in people if _is_payroll_worker(person)]

    def _lock_person(self, person_id: int) -> Person:
        person = self.db.scalar(
            select(Person)
            .where(Person.id == person_id, Person.deleted_at.is_(None))
            .with_for_update()
        )
        if person is None:
            raise PayrollSetupValidationError("Person nicht gefunden.")
        return person

    def _acquire_setup_lock(self) -> None:
        bind = self.db.get_bind()
        if bind.dialect.name == "postgresql":
            self.db.execute(
                text("SELECT pg_advisory_xact_lock(:key)"),
                {"key": PAYROLL_SETUP_ADVISORY_LOCK_KEY},
            )

    def _schedules_for_people(
        self,
        person_ids: set[int],
        period_start: date | None = None,
        period_end: date | None = None,
    ) -> dict[int, tuple[PersonWeeklySchedule, ...]]:
        if not person_ids:
            return {}
        statement = select(PersonWeeklySchedule).where(
            PersonWeeklySchedule.person_id.in_(person_ids)
        )
        if period_start is not None and period_end is not None:
            statement = statement.where(
                PersonWeeklySchedule.valid_from <= period_end,
                (
                    PersonWeeklySchedule.valid_until.is_(None)
                    | (PersonWeeklySchedule.valid_until >= period_start)
                ),
            )
        statement = statement.order_by(
            PersonWeeklySchedule.person_id,
            PersonWeeklySchedule.valid_from,
        )
        result: dict[int, list[PersonWeeklySchedule]] = defaultdict(list)
        for schedule in self.db.scalars(statement):
            result[schedule.person_id].append(schedule)
        return {person_id: tuple(items) for person_id, items in result.items()}

    def _openings_for_people(
        self, person_ids: set[int]
    ) -> dict[int, PersonHoursOpeningBalance]:
        if not person_ids:
            return {}
        return {
            opening.person_id: opening
            for opening in self.db.scalars(
                select(PersonHoursOpeningBalance)
                .options(selectinload(PersonHoursOpeningBalance.confirmed_by))
                .where(
                    PersonHoursOpeningBalance.person_id.in_(person_ids),
                    PersonHoursOpeningBalance.as_of_date == LEGACY_OPENING_DATE,
                )
            )
        }

    @staticmethod
    def _schedule_matches_payload(
        schedule: PersonWeeklySchedule, payload: PayrollWeeklyPlanUpsert
    ) -> bool:
        return (
            schedule.valid_until == payload.valid_to
            and schedule.weekday_minutes == tuple(payload.weekday_minutes)
            and schedule.note == payload.note
            and payload.confirm
        )

    @staticmethod
    def schedule_read(schedule: PersonWeeklySchedule) -> PayrollWeeklyPlanRead:
        return PayrollWeeklyPlanRead(
            id=schedule.id,
            valid_from=schedule.valid_from,
            valid_to=schedule.valid_until,
            weekday_minutes=list(schedule.weekday_minutes),
            weekly_minutes=schedule.weekly_total_minutes,
            contract_weekly_minutes=schedule.contract_weekly_minutes,
            is_confirmed=schedule.is_confirmed,
            confirmed_by_name=(
                schedule.confirmed_by.display_name if schedule.confirmed_by else None
            ),
            confirmed_at=schedule.confirmed_at,
            note=schedule.note,
        )

    @staticmethod
    def opening_read(opening: PersonHoursOpeningBalance) -> PayrollOpeningBalanceRead:
        return PayrollOpeningBalanceRead(
            id=opening.id,
            effective_date=opening.as_of_date,
            minutes=opening.balance_minutes,
            is_confirmed=opening.is_confirmed,
            confirmed_by_name=(
                opening.confirmed_by.display_name if opening.confirmed_by else None
            ),
            confirmed_at=opening.confirmed_at,
            note=opening.note,
        )


def _calculate_day_value(
    *,
    person_id: int,
    work_date: date,
    schedule: PersonWeeklySchedule,
    entries: list[WorkTimeEntry],
    absences: list[Absence],
    is_public_holiday: bool,
) -> tuple[PayrollDayLedgerValue | None, list[PayrollLedgerBlocker]]:
    blockers: list[PayrollLedgerBlocker] = []
    work_parts = sorted(
        ((entry.id, effective_weekly_work_minutes(entry)) for entry in entries),
        key=lambda item: item[0],
    )
    work_minutes = sum(minutes for _, minutes in work_parts)
    absence_types = {absence.absence_type for absence in absences}
    if len(absence_types) > 1:
        blockers.append(PayrollLedgerBlocker(
            code="conflicting_absence_types",
            message="Mehrere unterschiedliche Zeitarten gelten am selben Tag.",
            person_id=person_id,
            work_date=work_date,
        ))
    absence_type = next(iter(absence_types), None)
    if absence_type == AbsenceType.OTHER:
        blockers.append(PayrollLedgerBlocker(
            code="unsupported_absence_type",
            message="Die Zeitart 'Sonstige' ist für den Stundenabschluss nicht eindeutig.",
            person_id=person_id,
            work_date=work_date,
        ))
    if absence_type is not None and work_minutes:
        blockers.append(PayrollLedgerBlocker(
            code="work_absence_conflict",
            message="Arbeitszeit und Abwesenheit sind am selben Tag vorhanden.",
            person_id=person_id,
            work_date=work_date,
        ))
    if blockers:
        return None, blockers

    scheduled_target = schedule.target_minutes_for(work_date)
    target_minutes = 0 if is_public_holiday else scheduled_target
    credit_minutes = 0
    if absence_type == AbsenceType.FREE:
        target_minutes = 0
    elif absence_type in SUPPORTED_CREDIT_ABSENCES:
        credit_minutes = target_minutes
    actual_minutes = work_minutes + credit_minutes
    movement_minutes = actual_minutes - target_minutes
    source_payload = {
        "person_id": person_id,
        "work_date": work_date.isoformat(),
        "schedule_id": schedule.id,
        "scheduled_target_minutes": scheduled_target,
        "target_minutes": target_minutes,
        "work_entries": [
            {"id": entry_id, "minutes": minutes} for entry_id, minutes in work_parts
        ],
        "absence_ids": sorted(absence.id for absence in absences),
        "absence_type": absence_type.value if absence_type else None,
        "credit_minutes": credit_minutes,
        "actual_minutes": actual_minutes,
        "movement_minutes": movement_minutes,
        "is_public_holiday": is_public_holiday,
    }
    fingerprint = hashlib.sha256(
        json.dumps(source_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return PayrollDayLedgerValue(
        person_id=person_id,
        work_date=work_date,
        schedule_id=schedule.id,
        target_minutes=target_minutes,
        work_minutes=work_minutes,
        credit_minutes=credit_minutes,
        actual_minutes=actual_minutes,
        movement_minutes=movement_minutes,
        other_movement_minutes=0,
        absence_type=absence_type.value if absence_type else None,
        is_public_holiday=is_public_holiday,
        work_entry_ids=tuple(entry_id for entry_id, _ in work_parts),
        absence_ids=tuple(sorted(absence.id for absence in absences)),
        source_fingerprint=fingerprint,
    ), []


def _day_source_payload(day: PayrollDayLedgerValue) -> dict[str, object]:
    return {
        "schedule_id": day.schedule_id,
        "target_minutes": day.target_minutes,
        "work_minutes": day.work_minutes,
        "credit_minutes": day.credit_minutes,
        "actual_minutes": day.actual_minutes,
        "movement_minutes": day.movement_minutes,
        "absence_type": day.absence_type,
        "is_public_holiday": day.is_public_holiday,
        "work_entry_ids": list(day.work_entry_ids),
        "absence_ids": list(day.absence_ids),
    }


def _month_range(year: int, month: int) -> tuple[date, date]:
    try:
        return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])
    except ValueError as error:
        raise ValueError("Ungültiger Abrechnungsmonat.") from error


def _date_range(start: date, end: date) -> tuple[date, ...]:
    return tuple(start + timedelta(days=offset) for offset in range((end - start).days + 1))


def _date_ranges_overlap(
    first_start: date,
    first_end: date | None,
    second_start: date,
    second_end: date | None,
) -> bool:
    return first_start <= (second_end or date.max) and second_start <= (first_end or date.max)


def _contract_weekly_minutes(weekly_hours: float | None) -> int | None:
    if weekly_hours is None:
        return None
    value = Decimal(str(weekly_hours)) * Decimal("60")
    rounded = value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if value != rounded:
        raise PayrollSetupValidationError(
            "Die hinterlegten Wochenstunden ergeben keine ganzen Minuten."
        )
    return int(rounded)


def _format_weekly_hours(weekly_hours: float | None) -> str:
    if weekly_hours is None:
        return "noch nicht hinterlegten"
    value = Decimal(str(weekly_hours)).normalize()
    return format(value, "f").replace(".", ",")


def _format_date_range(start: date, end: date) -> str:
    start_label = start.strftime("%d.%m.%Y")
    if start == end:
        return start_label
    return f"{start_label} bis {end.strftime('%d.%m.%Y')}"


def _validate_source(source: str, reference_id: str) -> None:
    if not source.strip() or len(source) > 40:
        raise ValueError("Die Buchungsquelle ist ungültig.")
    if not reference_id.strip() or len(reference_id) > 120:
        raise ValueError("Eine eindeutige Abschlussreferenz ist erforderlich.")


def _daily_idempotency_key(
    *, source: str, reference_id: str, person_id: int, work_date: date
) -> str:
    raw = f"{source}:{reference_id}:daily:{person_id}:{work_date.isoformat()}"
    if len(raw) <= 255:
        return raw
    return f"daily:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def _is_payroll_worker(person: Person) -> bool:
    active_roles = {user.role for user in person.users if user.is_active}
    return not active_roles or active_roles == {UserRole.MONTEUR}


def lower_saxony_public_holidays(period_start: date, period_end: date) -> set[date]:
    """Public holidays already used by the payroll export; these carry zero target."""

    result: set[date] = set()
    for year in range(period_start.year, period_end.year + 1):
        easter = _easter_sunday(year)
        result.update({
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
        })
    return {holiday for holiday in result if period_start <= holiday <= period_end}


def _easter_sunday(year: int) -> date:
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
