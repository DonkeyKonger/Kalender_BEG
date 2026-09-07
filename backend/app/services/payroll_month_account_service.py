"""Accepted current balances with monthly credits capped at 100 hours.

The September 2026 transition deliberately accepts existing balances, including
legacy weekly automation. No old-week allocation or offset is inferred. Payroll
surplus above the account limit is an export amount, never another account debit.
"""
from __future__ import annotations

import calendar
from dataclasses import asdict
from datetime import date, datetime, timezone
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
ACCOUNT_LIMIT_MINUTES = 100 * 60
ACCOUNT_POLICY = "monthly_100h_v1"
LEGACY_CONFLICT_PREFIXES = ("Altbuchung KW ", "Alte Tagesbuchung ", "Alte Wochenbuchung ")


def _legacy_conflict(row: Entry) -> bool:
    reason = (row.source_payload or {}).get("pending_reason") or ""
    return row.entry_type == MONTHLY and reason.startswith(LEGACY_CONFLICT_PREFIXES)


def _duration(minutes: int) -> str:
    sign = "−" if minutes < 0 else "+" if minutes > 0 else ""
    hours, remainder = divmod(abs(minutes), 60)
    return f"{sign}{hours}:{remainder:02d} Std."


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
            return 0  # Exact compatibility case from 8c77461; no history rewrite.
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
            note=("Aktuell geführter Bestand als Anfangsbestand übernommen. Alte Wochenbuchungen "
                  "werden nicht erneut verrechnet; einmalige Übergangskorrekturen erfolgen manuell im September.")
                 if baseline is not None else "Anfangsbestand ungeklärt; Monatsbewegungen werden getrennt erfasst.",
            idempotency_key=f"monthly-transition:{person_id}", source_type=TRANSITION,
            created_by_user_id=user_id,
            source_payload={"baseline_minutes": baseline, "opening_id": opening.id if opening else None,
                            "captured_at": datetime.now(timezone.utc).isoformat(), "included_entries": snapshot,
                            "account_policy": ACCOUNT_POLICY},
        )
        self.db.add(row)
        self.db.flush()
        return row

    def current_balance(self, person_id: int, transition: Entry | None = None,
                        *, through: date | None = None) -> int | None:
        transition = transition or self.transition(person_id)
        if transition is None:
            raise ValueError("Monthly account transition has not been captured.")
        baseline = self._transition_baseline(transition)
        entries = self._entries(person_id)
        def in_period(row: Entry) -> bool:
            return through is None or row.effective_date is None or row.effective_date <= through

        if baseline is None or any(row.entry_type == MONTHLY and row.is_active and in_period(row)
                                   and (row.source_payload or {}).get("pending_reason")
                                   and not _legacy_conflict(row) for row in entries):
            return None
        current = {row.id: row for row in entries}
        for included in transition.source_payload["included_entries"]:
            row = current.get(included["id"])
            baseline += (row.minutes_delta if row is not None and row.is_active else 0) - included["minutes_delta"]
        # Captured legacy history is the explicitly accepted starting balance.
        # Only subsequent movements can be separated by their effective dates.
        # Monthly originals and their exact negative reversals form an event log.
        return baseline + sum(row.minutes_delta for row in entries if row.id > transition.id
                              and in_period(row)
                              and (row.is_active or row.entry_type in (MONTHLY, REVERSAL)))

    def notices(self, person_id: int) -> list[str]:
        transition = self.transition(person_id)
        if transition is None:
            return []
        notices = []
        if self._transition_baseline(transition) is None:
            notices.append("Anfangsbestand ungeklärt; der absolute Kontostand bleibt offen.")
        notices.extend(row.note for row in self._entries(person_id)
                       if row.entry_type == MONTHLY and row.is_active
                       and (row.source_payload or {}).get("pending_reason") and not _legacy_conflict(row))
        return notices

    def posting(self, reference_id: str | None) -> Entry | None:
        if not reference_id:
            return None
        return self.db.scalar(select(Entry).where(Entry.idempotency_key == f"monthly:{reference_id}"))

    def post(self, *, person_id: int, year: int, month: int, reference_id: str,
             totals: PayrollMonthTotals, user_id: int | None) -> Entry:
        transition = self.capture(person_id, user_id)
        existing = self.posting(reference_id)
        end = date(year, month, calendar.monthrange(year, month)[1])
        if existing is not None:
            if existing.person_id != person_id or existing.effective_date != end:
                raise ValueError("Monthly reference reused for a different person or period.")
            return existing
        active = list(self.db.scalars(select(Entry).where(
            Entry.person_id == person_id, Entry.entry_type == MONTHLY, Entry.is_active.is_(True),
        )))
        if any(row.effective_date == end for row in active):
            raise HTTPException(409, "Für diesen Monteurmonat besteht bereits eine aktive Monatsbuchung.")
        if any(row.effective_date is not None and row.effective_date > end for row in active):
            raise HTTPException(409, "Spätere Monteurmonate müssen zuerst wieder geöffnet werden.")
        before = self.current_balance(person_id, transition, through=end)
        pending = None
        if totals.overtime_minutes is None:
            pending = "Vertragswochenstunden fehlen; Monatsdifferenz und absoluter Kontostand bleiben offen."
        elif before is None:
            pending = "Anfangsbestand ungeklärt; Kontoauffüllung und Auszahlung bleiben offen."
        movement = totals.overtime_minutes
        # Negative months reduce the account. A surplus fills it to 100 hours;
        # an already higher accepted/manual balance is not silently written down.
        credit = (min(movement, max(0, ACCOUNT_LIMIT_MINUTES - before))
                  if pending is None and movement > 0 else movement if pending is None else 0)
        payout = max(0, movement - credit) if pending is None else None
        closing = before + credit if pending is None else None
        overridden = [row.id for row in active if _legacy_conflict(row)]
        payload = {"year": year, "month": month, "totals": asdict(totals),
                   "account_policy": ACCOUNT_POLICY, "account_limit_minutes": ACCOUNT_LIMIT_MINUTES,
                   "movement_minutes": movement, "booked_minutes": credit,
                   "payout_minutes": payout, "payout_surcharge_percent": 25,
                   "replaced_automatic_minutes": 0, "replaced_entry_ids": [],
                   "accepted_legacy_entry_ids": [item["id"] for item in transition.source_payload["included_entries"]
                                                 if item["entry_type"] in ("weekly_balance", "overtime_absence", "daily_balance")],
                   "overridden_legacy_conflict_ids": overridden,
                   "transition_entry_id": transition.id, "pending_reason": pending,
                   "balance_basis": "accepted_current_start_then_effective_month_movements",
                   "opening_balance_minutes": before if pending is None else None,
                   "closing_balance_minutes": closing}
        note = f"Monatsabschluss {month:02d}/{year}: "
        if pending:
            note += f"Monatsdifferenz: {_duration(movement) if movement is not None else 'unbekannt.'} {pending}"
        else:
            note += (f"Monatsdifferenz {_duration(movement)}; Stundenkonto {_duration(credit)} "
                     f"Auszahlung mit 25 % Zuschlag: {_duration(payout)} (Excel-Überstundenfeld, keine Kontobuchung).")
        if overridden:
            note += " Alte Wochenkonflikte übergangen; geführter Bestand übernommen."
        row = Entry(
            person_id=person_id, entry_type=MONTHLY, ledger_system="daily", effective_date=end,
            minutes_delta=credit, balance_after_minutes=closing, is_active=True,
            note=note, source_type="payroll_month_close", source_reference_id=reference_id,
            idempotency_key=f"monthly:{reference_id}", source_payload=payload, created_by_user_id=user_id,
        )
        self.db.add(row)
        self.db.flush()
        return row

    def reverse(self, reference_id: str | None, *, user_id: int | None) -> bool:
        original = self.posting(reference_id)
        if original is None:
            return False
        self.lock_person(original.person_id)
        self.db.refresh(original)
        if not original.is_active:
            return True
        original.is_active = False
        original.superseded_at = datetime.now(timezone.utc)
        self.db.flush()
        before = self.current_balance(original.person_id)
        delta = -original.minutes_delta
        payout = (original.source_payload or {}).get("payout_minutes")
        self.db.add(Entry(
            person_id=original.person_id, entry_type=REVERSAL, ledger_system="daily",
            effective_date=original.effective_date, minutes_delta=delta,
            balance_after_minutes=before + delta if before is not None else None,
            note=(f"Monatsabschluss zurückgenommen: Stundenkonto {_duration(delta)}"
                  + (f" Auszahlungshinweis {_duration(payout)} aufgehoben." if payout else "")),
            source_type="payroll_month_reopen", source_reference_id=reference_id,
            idempotency_key=f"monthly-reverse:{original.id}", is_active=True,
            source_payload={"reversed_entry_id": original.id, "reversed_payout_minutes": payout},
            created_by_user_id=user_id,
        ))
        self.db.flush()
        return True
