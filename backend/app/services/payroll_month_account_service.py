"""Monthly Excel movements over a captured, current account (never a backdated opening).

Old postings stay intact. The transition records exactly which active postings
were included in the accepted balance. A monthly replacement deducts only that
month's identifiable old automation, never manual adjustments or payouts.
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payroll_daily_ledger import PersonHoursOpeningBalance
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry as Entry
if TYPE_CHECKING:
    from app.services.payroll_month_xlsx_service import PayrollMonthTotals

TRANSITION = "monthly_transition"
MONTHLY = "monthly_balance"
REVERSAL = "monthly_reversal"


class PayrollMonthAccountService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def lock_person(self, person_id: int) -> None:
        # Call after period locks. Manual writers use this same row lock.
        self.db.execute(select(Person.id).where(Person.id == person_id).with_for_update()).scalar_one()

    def transition(self, person_id: int) -> Entry | None:
        return self.db.scalar(select(Entry).where(Entry.idempotency_key == f"monthly-transition:{person_id}"))

    def _entries(self, person_id: int) -> list[Entry]:
        return list(self.db.scalars(select(Entry).where(Entry.person_id == person_id).order_by(Entry.id)))

    @staticmethod
    def accepted_balance(opening: PersonHoursOpeningBalance | None, entries: list[Entry]) -> int | None:
        included = [row for row in entries if row.is_active and (opening is None or row.ledger_system == "daily")]
        # The established account defines an empty history as a regular zero.
        # An explicitly unknown balance on actual history is a different case.
        if opening is None and any(row.balance_after_minutes is None for row in included):
            return None
        return (opening.balance_minutes if opening is not None else 0) + sum(row.minutes_delta for row in included)

    @staticmethod
    def _transition_baseline(transition: Entry) -> int | None:
        payload = transition.source_payload
        baseline = payload["baseline_minutes"]
        if (baseline is None and payload.get("included_entries") == []
                and "opening_id" in payload and payload["opening_id"] is None
                and transition.source_type == TRANSITION
                and transition.note == "Anfangsbestand ungeklärt; Monatsbewegungen werden getrennt erfasst."):
            # Compatibility with the precise empty-zero misclassification in
            # 8c77461. Keep its original row, payload and frozen exports intact.
            return 0
        return baseline

    def capture(self, person_id: int, user_id: int | None) -> Entry:
        self.lock_person(person_id)
        existing = self.transition(person_id)
        if existing is not None:
            return existing
        opening = self.db.scalar(select(PersonHoursOpeningBalance).where(
            PersonHoursOpeningBalance.person_id == person_id,
            PersonHoursOpeningBalance.is_confirmed.is_(True),
        ))
        entries = [row for row in self._entries(person_id)
                   if row.is_active and (opening is None or row.ledger_system == "daily")]
        baseline = self.accepted_balance(opening, entries)
        snapshot = [{
            "id": row.id, "minutes_delta": row.minutes_delta, "entry_type": row.entry_type,
            "ledger_system": row.ledger_system,
            "effective_date": row.effective_date.isoformat() if row.effective_date else None,
            "iso_year": row.iso_year, "iso_week": row.iso_week,
            "source_type": row.source_type, "source_reference_id": row.source_reference_id,
        } for row in entries]
        row = Entry(
            person_id=person_id, entry_type=TRANSITION, ledger_system="legacy",
            minutes_delta=0, balance_after_minutes=baseline, is_active=True,
            note="Aktuell geführter Bestand übernommen; keine rückdatierte Eröffnung."
                 if baseline is not None else "Anfangsbestand ungeklärt; Monatsbewegungen werden getrennt erfasst.",
            idempotency_key=f"monthly-transition:{person_id}", source_type=TRANSITION,
            created_by_user_id=user_id,
            source_payload={"baseline_minutes": baseline, "opening_id": opening.id if opening else None,
                            "captured_at": datetime.now(timezone.utc).isoformat(), "included_entries": snapshot},
        )
        self.db.add(row)
        self.db.flush()
        return row

    def current_balance(self, person_id: int, transition: Entry | None = None) -> int | None:
        transition = transition or self.transition(person_id)
        if transition is None:
            raise ValueError("Monthly account transition has not been captured.")
        baseline = self._transition_baseline(transition)
        entries = self._entries(person_id)
        if baseline is None or any(row.entry_type == MONTHLY and row.is_active
                                   and row.source_payload.get("pending_reason") for row in entries):
            return None
        current = {row.id: row for row in entries}
        for included in transition.source_payload["included_entries"]:
            row = current.get(included["id"])
            baseline += (row.minutes_delta if row is not None and row.is_active else 0) - included["minutes_delta"]
        # Monthly originals and their exact negative reversal are an event log.
        # is_active selects the current version; it does not erase its old delta.
        return baseline + sum(row.minutes_delta for row in entries if row.id > transition.id
                              and (row.is_active or row.entry_type in (MONTHLY, REVERSAL)))

    def notices(self, person_id: int) -> list[str]:
        transition = self.transition(person_id)
        if transition is None:
            return []
        notices = []
        if self._transition_baseline(transition) is None:
            notices.append("Anfangsbestand ungeklärt; der absolute Kontostand bleibt offen.")
        notices.extend(row.note for row in self._entries(person_id)
                       if row.entry_type == MONTHLY and row.is_active and row.source_payload.get("pending_reason"))
        return notices

    def _old_month_offset(self, transition: Entry, start: date, end: date) -> tuple[int, list[int], str | None]:
        current = {row.id: row for row in self._entries(transition.person_id)}
        offset = 0
        ids: list[int] = []
        weeks: dict[tuple, list[dict]] = defaultdict(list)
        for item in transition.source_payload["included_entries"]:
            row = current.get(item["id"])
            if row is None or not row.is_active:
                continue
            if item["entry_type"] == "daily_balance":
                effective = date.fromisoformat(item["effective_date"]) if item["effective_date"] else None
                if effective is None:
                    return offset, ids, "Alte Tagesbuchung ohne belastbares Datum; Monatszuordnung offen."
                if start <= effective <= end:
                    offset += row.minutes_delta
                    ids.append(row.id)
            elif item["entry_type"] in ("weekly_balance", "overtime_absence"):
                weeks[(item["iso_year"], item["iso_week"])].append(item)
        for (year, week), items in weeks.items():
            net = sum(current[item["id"]].minutes_delta for item in items)
            if net == 0:
                continue
            try:
                monday = date.fromisocalendar(year, week, 1)
            except (ValueError, TypeError):
                return offset, ids, "Alte Wochenbuchung ohne belastbare KW; Monatszuordnung offen."
            sunday = monday + timedelta(days=6)
            if monday <= end and sunday >= start:
                if monday < start or sunday > end:
                    return offset, ids, f"Altbuchung KW {week:02d}/{year} über Monatsgrenze: Zuordnung offen."
                offset += net
                ids.extend(item["id"] for item in items)
        return offset, ids, None

    def posting(self, reference_id: str | None) -> Entry | None:
        if not reference_id:
            return None
        return self.db.scalar(select(Entry).where(Entry.idempotency_key == f"monthly:{reference_id}"))

    def post(self, *, person_id: int, year: int, month: int, reference_id: str,
             totals: PayrollMonthTotals, user_id: int | None) -> Entry:
        transition = self.capture(person_id, user_id)
        existing = self.posting(reference_id)
        if existing is not None:
            if existing.person_id != person_id or existing.effective_date != date(year, month, calendar.monthrange(year, month)[1]):
                raise ValueError("Monthly reference reused for a different person or period.")
            return existing
        start, end = date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])
        if self.db.scalar(select(Entry.id).where(Entry.person_id == person_id, Entry.entry_type == MONTHLY,
                                               Entry.effective_date == end, Entry.is_active.is_(True))):
            raise HTTPException(409, "Für diesen Monteurmonat besteht bereits eine aktive Monatsbuchung.")
        before = self.current_balance(person_id, transition)
        offset, included_ids, pending = self._old_month_offset(transition, start, end)
        if totals.overtime_minutes is None:
            pending = "Vertragswochenstunden fehlen; Monatsdifferenz und absoluter Kontostand bleiben offen."
        delta = totals.overtime_minutes - offset if pending is None else 0
        opening = before - offset if before is not None and pending is None else None
        closing = before + delta if before is not None and pending is None else None
        payload = {"year": year, "month": month, "totals": asdict(totals),
                   "movement_minutes": totals.overtime_minutes, "booked_minutes": delta,
                   "replaced_automatic_minutes": offset, "replaced_entry_ids": included_ids,
                   "transition_entry_id": transition.id, "pending_reason": pending,
                   "balance_basis": "current_at_booking_not_historical_month_opening",
                   "opening_balance_minutes": opening, "closing_balance_minutes": closing}
        row = Entry(
            person_id=person_id, entry_type=MONTHLY, ledger_system="daily", effective_date=end,
            minutes_delta=delta, balance_after_minutes=closing, is_active=True,
            note=f"Monatsabschluss {month:02d}/{year}: " + (
                f"Excel-Differenz {totals.overtime_minutes if totals.overtime_minutes is not None else 'unbekannt'}"
                f"{' Min.' if totals.overtime_minutes is not None else ''}; noch keine Verrechnung gebucht. {pending}"
                if pending else
                f"Excel-Differenz {totals.overtime_minutes} Min.; enthaltene Alt-Automatik {offset} Min.; gebucht {delta} Min."),
            source_type="payroll_month_close", source_reference_id=reference_id,
            idempotency_key=f"monthly:{reference_id}", source_payload=payload, created_by_user_id=user_id,
        )
        self.db.add(row)
        self.db.flush()
        return row

    def reverse(self, reference_id: str | None, *, user_id: int | None) -> bool:
        original = self.posting(reference_id)
        if original is None:
            return False  # Historical daily approval; caller uses its old reversal path.
        self.lock_person(original.person_id)
        self.db.refresh(original)
        if not original.is_active:
            return True
        original.is_active = False
        original.superseded_at = datetime.now(timezone.utc)
        self.db.flush()
        before = self.current_balance(original.person_id)
        delta = -original.minutes_delta
        self.db.add(Entry(
            person_id=original.person_id, entry_type=REVERSAL, ledger_system="daily",
            effective_date=original.effective_date, minutes_delta=delta,
            balance_after_minutes=before + delta if before is not None else None,
            note=f"Monatsabschluss zurückgenommen: tatsächlich gebuchte Wirkung {delta} Min.",
            source_type="payroll_month_reopen", source_reference_id=reference_id,
            idempotency_key=f"monthly-reverse:{original.id}", is_active=True,
            source_payload={"reversed_entry_id": original.id}, created_by_user_id=user_id,
        ))
        self.db.flush()
        return True
