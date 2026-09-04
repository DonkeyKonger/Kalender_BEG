from __future__ import annotations

from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.models.payroll_month import (
    PAYROLL_MONTH_LOCKED,
    PAYROLL_PERSON_MONTH_APPROVED,
    PayrollMonthPeriod,
    PayrollMonthPersonApproval,
)


LOCKED_PERIOD_ERROR_CODE = "payroll_month_locked"
LOCKED_PERSON_PERIOD_ERROR_CODE = "payroll_person_month_locked"


class PayrollPeriodGuard:
    """Single application-level guard for every payroll-relevant mutation.

    PostgreSQL triggers provide the final defence against direct SQL and races;
    this guard supplies a stable HTTP conflict contract to every API path.
    """

    def __init__(self, db: Session) -> None:
        self.db = db

    def assert_date_mutable(self, work_date: date | None, *, person_id: int | None = None) -> None:
        if work_date is None or not self._supports_queries():
            return
        period = self._locked_period_for_date(work_date)
        if period is not None:
            self._raise_locked(period)
        if person_id is not None:
            approval = self._approved_person_period_for_date(person_id, work_date)
            if approval is not None:
                self._raise_person_locked(approval)

    def is_date_locked(self, work_date: date) -> bool:
        if not self._supports_queries():
            return False
        return self._locked_period_for_date(work_date) is not None

    def _locked_period_for_date(self, work_date: date) -> PayrollMonthPeriod | None:
        self.acquire_month_lock(work_date.year, work_date.month)
        return self.db.scalar(
            select(PayrollMonthPeriod).where(
                PayrollMonthPeriod.year == work_date.year,
                PayrollMonthPeriod.month == work_date.month,
                PayrollMonthPeriod.status == PAYROLL_MONTH_LOCKED,
            )
        )

    def assert_dates_mutable(self, *work_dates: date | None, person_id: int | None = None) -> None:
        if not self._supports_queries():
            return
        dates = {item for item in work_dates if item is not None}
        if not dates:
            return
        month_keys = sorted({(item.year, item.month) for item in dates})
        for year, month in month_keys:
            self.acquire_month_lock(year, month)
        clauses = [
            (
                (PayrollMonthPeriod.year == item.year)
                & (PayrollMonthPeriod.month == item.month)
            )
            for item in dates
        ]
        period = self.db.scalar(
            select(PayrollMonthPeriod)
            .where(PayrollMonthPeriod.status == PAYROLL_MONTH_LOCKED)
            .where(or_(*clauses))
            .order_by(PayrollMonthPeriod.year, PayrollMonthPeriod.month)
            .limit(1)
        )
        if period is not None:
            self._raise_locked(period)
        if person_id is not None:
            approval_clauses = [
                (
                    (PayrollMonthPersonApproval.year == item.year)
                    & (PayrollMonthPersonApproval.month == item.month)
                )
                for item in dates
            ]
            approval = self.db.scalar(
                select(PayrollMonthPersonApproval)
                .where(
                    PayrollMonthPersonApproval.person_id == person_id,
                    PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
                )
                .where(or_(*approval_clauses))
                .order_by(PayrollMonthPersonApproval.year, PayrollMonthPersonApproval.month)
                .limit(1)
            )
            if approval is not None:
                self._raise_person_locked(approval)

    def assert_range_mutable(self, start_date: date, end_date: date, *, person_id: int | None = None) -> None:
        if not self._supports_queries():
            return
        if end_date < start_date:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
        month_keys: list[tuple[int, int]] = []
        cursor = date(start_date.year, start_date.month, 1)
        last = date(end_date.year, end_date.month, 1)
        while cursor <= last:
            month_keys.append((cursor.year, cursor.month))
            cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        clauses = [
            (PayrollMonthPeriod.year == year) & (PayrollMonthPeriod.month == month)
            for year, month in month_keys
        ]
        for year, month in month_keys:
            self.acquire_month_lock(year, month)
        period = self.db.scalar(
            select(PayrollMonthPeriod)
            .where(PayrollMonthPeriod.status == PAYROLL_MONTH_LOCKED)
            .where(or_(*clauses))
            .order_by(PayrollMonthPeriod.year, PayrollMonthPeriod.month)
            .limit(1)
        )
        if period is not None:
            self._raise_locked(period)
        if person_id is not None:
            approval_clauses = [
                (
                    (PayrollMonthPersonApproval.year == year)
                    & (PayrollMonthPersonApproval.month == month)
                )
                for year, month in month_keys
            ]
            approval = self.db.scalar(
                select(PayrollMonthPersonApproval)
                .where(
                    PayrollMonthPersonApproval.person_id == person_id,
                    PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
                )
                .where(or_(*approval_clauses))
                .order_by(PayrollMonthPersonApproval.year, PayrollMonthPersonApproval.month)
                .limit(1)
            )
            if approval is not None:
                self._raise_person_locked(approval)

    def _approved_person_period_for_date(
        self,
        person_id: int,
        work_date: date,
    ) -> PayrollMonthPersonApproval | None:
        self.acquire_month_lock(work_date.year, work_date.month)
        return self.db.scalar(
            select(PayrollMonthPersonApproval).where(
                PayrollMonthPersonApproval.year == work_date.year,
                PayrollMonthPersonApproval.month == work_date.month,
                PayrollMonthPersonApproval.person_id == person_id,
                PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
            )
        )

    def assert_open_ended_range_mutable(self, start_date: date, *, person_id: int | None = None) -> None:
        """Reject an open-ended effective range if any covered month is locked.

        Schedule administration acquires the shared setup/close lock before this
        query, so a new month cannot become locked between the check and write.
        """
        if not self._supports_queries():
            return
        self.acquire_month_lock(start_date.year, start_date.month)
        start_key = start_date.year * 100 + start_date.month
        period = self.db.scalar(
            select(PayrollMonthPeriod)
            .where(
                PayrollMonthPeriod.status == PAYROLL_MONTH_LOCKED,
                PayrollMonthPeriod.year * 100 + PayrollMonthPeriod.month >= start_key,
            )
            .order_by(PayrollMonthPeriod.year, PayrollMonthPeriod.month)
            .limit(1)
        )
        if period is not None:
            self._raise_locked(period)
        if person_id is not None:
            approval = self.db.scalar(
                select(PayrollMonthPersonApproval)
                .where(
                    PayrollMonthPersonApproval.person_id == person_id,
                    PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
                    PayrollMonthPersonApproval.year * 100 + PayrollMonthPersonApproval.month >= start_key,
                )
                .order_by(PayrollMonthPersonApproval.year, PayrollMonthPersonApproval.month)
                .limit(1)
            )
            if approval is not None:
                self._raise_person_locked(approval)

    @staticmethod
    def _raise_locked(period: PayrollMonthPeriod) -> None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": LOCKED_PERIOD_ERROR_CODE,
                "year": period.year,
                "month": period.month,
                "locked_at": period.locked_at.isoformat() if period.locked_at else None,
                "message": (
                    f"Der Abrechnungsmonat {period.month:02d}/{period.year} ist abgeschlossen "
                    "und kann nicht verändert werden. Öffnen Sie ihn zuerst in der Monatsauswertung wieder."
                ),
            },
        )

    @staticmethod
    def _raise_person_locked(approval: PayrollMonthPersonApproval) -> None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": LOCKED_PERSON_PERIOD_ERROR_CODE,
                "year": approval.year,
                "month": approval.month,
                "person_id": approval.person_id,
                "locked_at": approval.approved_at.isoformat() if approval.approved_at else None,
                "message": (
                    f"Der Monteurmonat {approval.month:02d}/{approval.year} ist geprüft "
                    "und kann nicht verändert werden. Öffnen Sie den Monteurmonat zuerst in der Monatsauswertung wieder."
                ),
            },
        )

    def acquire_month_lock(self, year: int, month: int) -> None:
        """Serialize a close/reopen with every relevant write on PostgreSQL."""
        bind = self.db.get_bind()
        if bind.dialect.name != "postgresql":
            return
        # Namespace 0x504159 ("PAY") avoids collisions with unrelated advisory locks.
        key = 0x5041590000 + year * 100 + month
        self.db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})

    def _supports_queries(self) -> bool:
        return all(hasattr(self.db, name) for name in ("get_bind", "scalar"))
