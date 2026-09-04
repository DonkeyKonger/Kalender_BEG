from __future__ import annotations

import calendar
import hashlib
import json
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from app.core.office_permissions import OFFICE_PAGE_PAYROLL, office_user_can_access
from app.models.enums import AbsenceStatus, UserRole
from app.models.payroll_daily_ledger import PAYROLL_LEDGER_CUTOVER_DATE
from app.models.payroll_month import (
    PAYROLL_MONTH_LOCKED,
    PAYROLL_MONTH_OPEN,
    PAYROLL_PERSON_MONTH_APPROVED,
    PAYROLL_PERSON_MONTH_OPEN,
    PayrollMonthArtifact,
    PayrollMonthAudit,
    PayrollMonthPeriod,
    PayrollMonthPersonApproval,
    PayrollMonthPersonApprovalArtifact,
    PayrollMonthPersonSnapshot,
    PayrollMonthSnapshot,
)
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.schemas.payroll_month import (
    PayrollMonthBlocker,
    PayrollMonthPersonApprovalRead,
    PayrollMonthPersonApprovalSummary,
    PayrollMonthStatusRead,
)
from app.services.audit_service import AuditService
from app.services.payroll_month_export_service import (
    PayrollMonthSourceBundle,
    PayrollMonthExportService,
    payroll_month_source_range,
)
from app.services.payroll_month_xlsx_service import build_payroll_month_plan
from app.services.payroll_period_guard import PayrollPeriodGuard
from app.services.payroll_xlsx_template import PayrollXlsxTemplateError, load_payroll_monthly_template
from app.services.gps_service import GpsPresenceService
from app.services.time_entry_service import TimeEntryService


PAYROLL_MONTH_SOURCE = "payroll_month_close"
PAYROLL_PERSON_MONTH_SOURCE = "payroll_person_month_close"
PAYROLL_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PAYROLL_GLOBAL_ADVISORY_LOCK_KEY = 5_259_609
PERSON_MONTH_APPROVAL_STATUS = "ACKNOWLEDGED_BY_PERSON_MONTH_APPROVAL"
PERSON_MONTH_TECHNICAL_BLOCKER_CODES = {
    "before_cutover",
    "conflicting_absence_types",
    "daily_entry_without_date",
    "finalization_reference_reused",
    "finalized_day_changed",
    "incomplete_work_interval",
    "invalid_absence_range",
    "invalid_break_minutes",
    "invalid_break_or_interval",
    "invalid_work_minutes",
    "no_payroll_workers",
    "opening_balance_missing",
    "overlapping_work_intervals",
    "payroll_export_source_invalid",
    "payroll_export_validation_failed",
    "payroll_month_before_cutover",
    "payroll_template_invalid",
    "previous_payroll_month_not_locked",
    "schedule_contract_mismatch",
    "schedule_missing",
    "schedule_overlap",
    "schedule_unconfirmed",
    "unsupported_absence_type",
    "work_absence_conflict",
}


class PayrollMonthCloseService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_status(self, *, year: int, month: int, current_user: User) -> PayrollMonthStatusRead:
        _validate_month(year, month)
        period = self._period(year, month)
        current_snapshot = self._current_snapshot(period)
        people = self._payroll_people()
        approvals = self._person_approvals(year, month)
        blockers: list[PayrollMonthBlocker] = []
        if period is None or period.status == PAYROLL_MONTH_OPEN:
            blockers = self._readiness_blockers(year, month, current_user)
            predecessor = self._predecessor_blocker(year, month)
            if predecessor is not None:
                blockers.insert(0, predecessor)
        status_value = period.status if period is not None else PAYROLL_MONTH_OPEN
        may_manage = _may_manage_payroll(current_user)
        artifacts_ready = bool(
            status_value == PAYROLL_MONTH_LOCKED
            and current_snapshot is not None
            and self._artifacts_ready(current_snapshot)
        )
        person_approvals = self._person_approval_reads(
            year=year,
            month=month,
            people=people,
            approvals=approvals,
            blockers=blockers,
            month_status=status_value,
            month_locked_at=period.locked_at if period else None,
            month_locked_by_name=(period.locked_by.display_name if period and period.locked_by else None),
            month_artifacts_ready=artifacts_ready,
            may_manage=may_manage,
        )
        approved_person_ids = {
            item.person_id
            for item in person_approvals
            if item.status == PAYROLL_PERSON_MONTH_APPROVED
        }
        all_people_approved = bool(people) and len(approved_person_ids) == len(people)
        unresolved_blockers = self._unresolved_month_blockers(blockers, approved_person_ids)
        can_reopen = bool(
            may_manage
            and status_value == PAYROLL_MONTH_LOCKED
            and not self._has_later_locked_month(year, month)
        )
        return PayrollMonthStatusRead(
            year=year,
            month=month,
            status=status_value,
            snapshot_id=current_snapshot.id if current_snapshot else None,
            snapshot_version=current_snapshot.version if current_snapshot else None,
            locked_at=period.locked_at if period else None,
            locked_by_name=(period.locked_by.display_name if period and period.locked_by else None),
            can_lock=bool(
                may_manage
                and status_value == PAYROLL_MONTH_OPEN
                and all_people_approved
                and not unresolved_blockers
            ),
            can_reopen=can_reopen,
            artifacts_ready=artifacts_ready,
            blockers=blockers,
            person_approval_summary=PayrollMonthPersonApprovalSummary(
                approved_count=len(approved_person_ids),
                total_count=len(people),
            ),
            person_approvals=person_approvals,
        )

    def lock_month(
        self,
        *,
        year: int,
        month: int,
        confirmed: bool,
        current_user: User,
    ) -> PayrollMonthStatusRead:
        _validate_month(year, month)
        _ensure_may_manage(current_user)
        if not confirmed:
            error = HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {"code": "payroll_close_confirmation_required", "message": "Der Monatsabschluss muss ausdrücklich bestätigt werden."},
            )
            self._audit_close_failure(year, month, current_user, error)
            raise error
        if date(year, month, 1) < PAYROLL_LEDGER_CUTOVER_DATE:
            error = HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {"code": "payroll_month_before_cutover", "message": "Monate vor dem Umstellungsstichtag können nicht mit dem neuen Verfahren abgeschlossen werden."},
            )
            self._audit_close_failure(year, month, current_user, error)
            raise error
        try:
            self._acquire_close_locks(year, month)
            period = self._get_or_create_locked_period_row(year, month)
            if period.status == PAYROLL_MONTH_LOCKED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {"code": "payroll_month_already_locked", "year": year, "month": month, "message": "Der Monat ist bereits abgeschlossen."},
                )
            predecessor = self._predecessor_blocker(year, month)
            if predecessor is not None:
                self._raise_blockers([predecessor])
            blockers = self._readiness_blockers(year, month, current_user)
            approved_person_ids = self._approved_person_ids(year, month)
            missing_approvals = [
                PayrollMonthBlocker(
                    code="payroll_person_month_not_approved",
                    message=f"{person.display_name} ist noch nicht im Monteurabschluss geprüft.",
                    person_id=person.id,
                )
                for person in self._payroll_people()
                if person.id not in approved_person_ids
            ]
            blockers = missing_approvals + self._unresolved_month_blockers(
                blockers,
                approved_person_ids,
            )
            if blockers:
                self._raise_blockers(blockers)

            version = period.last_snapshot_version + 1
            reference_id = f"payroll-month:{year:04d}-{month:02d}:v{version}"
            ledger_result = self._ledger_service().finalize_month(
                year=year,
                month=month,
                source=PAYROLL_MONTH_SOURCE,
                reference_id=reference_id,
                created_by_user_id=current_user.id,
            )
            person_values = self._normalise_finalization(ledger_result)
            if not person_values:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {"code": "payroll_month_has_no_workers", "message": "Der Monat enthält keine abrechenbaren Monteure."},
                )

            export_service = PayrollMonthExportService(self.db)
            export_source = export_service.load_live_source(
                year=year,
                month=month,
                current_user=current_user,
            )
            if {person.id for person in export_source.people} != {
                item["person_id"] for item in person_values
            }:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_snapshot_person_mismatch",
                        "message": "Ledger und Export enthalten nicht dieselben abrechenbaren Monteure.",
                    },
                )
            artifact_specs = self._build_artifact_specs(
                export_service=export_service,
                export_source=export_source,
                year=year,
                month=month,
                version=version,
                person_values=person_values,
            )
            period_start = date(year, month, 1)
            period_end = date(year, month, calendar.monthrange(year, month)[1])
            payload = {
                "schema_version": 1,
                "year": year,
                "month": month,
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
                "cutover_date": PAYROLL_LEDGER_CUTOVER_DATE.isoformat(),
                "reference_id": reference_id,
                "people": person_values,
                "export_source": export_service.source_manifest(export_source),
                "artifacts": [
                    {
                        "artifact_key": item["artifact_key"],
                        "person_id": item["person_id"],
                        "filename": item["filename"],
                        "byte_size": len(item["content"]),
                        "content_sha256": hashlib.sha256(item["content"]).hexdigest(),
                    }
                    for item in artifact_specs
                ],
            }
            snapshot = PayrollMonthSnapshot(
                period_id=period.id,
                version=version,
                reference_id=reference_id,
                period_start=period_start,
                period_end=period_end,
                cutover_date=PAYROLL_LEDGER_CUTOVER_DATE,
                payload_json=payload,
                payload_sha256=_sha256_json(payload),
                created_by_user_id=current_user.id,
            )
            self.db.add(snapshot)
            self.db.flush()

            for item in person_values:
                row_payload = {
                    "person_id": item["person_id"],
                    "opening_balance_minutes": item["opening_balance_minutes"],
                    "movement_minutes": item["movement_minutes"],
                    "closing_balance_minutes": item["closing_balance_minutes"],
                    "days": item["days"],
                }
                self.db.add(
                    PayrollMonthPersonSnapshot(
                        snapshot_id=snapshot.id,
                        person_id=item["person_id"],
                        person_name=item["person_name"],
                        opening_balance_minutes=item["opening_balance_minutes"],
                        movement_minutes=item["movement_minutes"],
                        closing_balance_minutes=item["closing_balance_minutes"],
                        daily_values_json=item["days"],
                        source_sha256=_sha256_json(row_payload),
                    )
                )
            self.db.flush()
            self._persist_artifacts(
                snapshot=snapshot,
                artifact_specs=artifact_specs,
                user_id=current_user.id,
            )

            now = datetime.now(timezone.utc)
            period.status = PAYROLL_MONTH_LOCKED
            period.last_snapshot_version = version
            period.row_version += 1
            period.locked_at = now
            period.locked_by_user_id = current_user.id
            period.reopened_at = None
            period.reopened_by_user_id = None
            audit = PayrollMonthAudit(
                period_id=period.id,
                snapshot_id=snapshot.id,
                action="MONTH_LOCKED" if version == 1 else "MONTH_RELOCKED",
                status_before=PAYROLL_MONTH_OPEN,
                status_after=PAYROLL_MONTH_LOCKED,
                details_json={
                    "snapshot_version": version,
                    "payload_sha256": snapshot.payload_sha256,
                    "person_count": len(person_values),
                },
                user_id=current_user.id,
            )
            self.db.add(audit)
            AuditService(self.db).record(
                user_id=current_user.id,
                action="payroll_month.locked",
                entity_type="payroll_month_period",
                entity_id=period.id,
                old_value={"status": PAYROLL_MONTH_OPEN},
                new_value={
                    "status": PAYROLL_MONTH_LOCKED,
                    "year": year,
                    "month": month,
                    "snapshot_id": snapshot.id,
                    "snapshot_version": version,
                    "payload_sha256": snapshot.payload_sha256,
                },
            )
            self.db.commit()
        except Exception as error:
            self.db.rollback()
            self._audit_close_failure(year, month, current_user, error)
            self._raise_ledger_validation(error)
            raise
        return self.get_status(year=year, month=month, current_user=current_user)

    def reopen_month(
        self,
        *,
        year: int,
        month: int,
        reason: str,
        current_user: User,
    ) -> PayrollMonthStatusRead:
        _validate_month(year, month)
        _ensure_may_manage(current_user)
        reason = (reason or "").strip()
        if not reason:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eine Begründung ist Pflicht.")
        try:
            self._acquire_close_locks(year, month)
            period = self.db.scalar(
                select(PayrollMonthPeriod)
                .where(PayrollMonthPeriod.year == year, PayrollMonthPeriod.month == month)
                .with_for_update()
            )
            if period is None or period.status != PAYROLL_MONTH_LOCKED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {"code": "payroll_month_not_locked", "message": "Nur ein abgeschlossener Monat kann wieder geöffnet werden."},
                )
            if self._has_later_locked_month(year, month):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_later_month_locked",
                        "message": "Spätere abgeschlossene Monate müssen zuerst in umgekehrter Reihenfolge geöffnet werden.",
                    },
                )
            snapshot = self._current_snapshot(period)
            if snapshot is None:
                raise HTTPException(status.HTTP_409_CONFLICT, "Snapshot des Monatsabschlusses fehlt.")

            # Open inside the same transaction before superseding ledger rows so
            # the database write guard allows precisely this audited reversal.
            now = datetime.now(timezone.utc)
            period.status = PAYROLL_MONTH_OPEN
            period.row_version += 1
            period.locked_at = None
            period.locked_by_user_id = None
            period.reopened_at = now
            period.reopened_by_user_id = current_user.id
            self.db.flush()
            person_approvals_to_reopen = list(self.db.scalars(
                select(PayrollMonthPersonApproval)
                .where(
                    PayrollMonthPersonApproval.year == year,
                    PayrollMonthPersonApproval.month == month,
                    PayrollMonthPersonApproval.status == PAYROLL_PERSON_MONTH_APPROVED,
                )
                .with_for_update()
            ))
            for approval in person_approvals_to_reopen:
                approval.status = PAYROLL_PERSON_MONTH_OPEN
                approval.ledger_reference_id = None
                approval.reopened_at = now
                approval.reopened_by_user_id = current_user.id
                approval.reopen_reason = reason
            self.db.flush()
            superseded_count = self._ledger_service().unfinalize_month(
                year=year,
                month=month,
                source=PAYROLL_MONTH_SOURCE,
                reference_id=snapshot.reference_id,
            )
            self.db.add(
                PayrollMonthAudit(
                    period_id=period.id,
                    snapshot_id=snapshot.id,
                    action="MONTH_REOPENED",
                    status_before=PAYROLL_MONTH_LOCKED,
                    status_after=PAYROLL_MONTH_OPEN,
                    reason=reason,
                    details_json={
                        "snapshot_version": snapshot.version,
                        "superseded_ledger_entries": int(superseded_count or 0),
                        "reopened_person_approvals": len(person_approvals_to_reopen),
                    },
                    user_id=current_user.id,
                )
            )
            AuditService(self.db).record(
                user_id=current_user.id,
                action="payroll_month.reopened",
                entity_type="payroll_month_period",
                entity_id=period.id,
                old_value={"status": PAYROLL_MONTH_LOCKED, "snapshot_version": snapshot.version},
                new_value={"status": PAYROLL_MONTH_OPEN, "reason": reason},
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return self.get_status(year=year, month=month, current_user=current_user)

    def list_audits(self, *, year: int, month: int) -> list[PayrollMonthAudit]:
        _validate_month(year, month)
        period = self._period(year, month)
        if period is None:
            return []
        return list(
            self.db.scalars(
                select(PayrollMonthAudit)
                .where(PayrollMonthAudit.period_id == period.id)
                .order_by(PayrollMonthAudit.created_at.desc(), PayrollMonthAudit.id.desc())
            )
        )

    def approve_person_month(
        self,
        *,
        year: int,
        month: int,
        person_id: int,
        confirmed: bool,
        acknowledged_blocker_count: int,
        current_user: User,
    ) -> PayrollMonthStatusRead:
        _validate_month(year, month)
        _ensure_may_manage(current_user)
        if not confirmed:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {
                    "code": "payroll_person_month_confirmation_required",
                    "message": "Der Monteurabschluss muss ausdrücklich bestätigt werden.",
                },
            )
        if date(year, month, 1) < PAYROLL_LEDGER_CUTOVER_DATE:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                {
                    "code": "payroll_month_before_cutover",
                    "message": "Monate vor dem Umstellungsstichtag können nicht mit dem neuen Verfahren abgeschlossen werden.",
                },
            )
        try:
            self._acquire_close_locks(year, month)
            period = self._get_or_create_locked_period_row(year, month)
            if period.status == PAYROLL_MONTH_LOCKED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_month_locked",
                        "message": "Der Gesamtmonat ist bereits abgeschlossen. Öffnen Sie ihn zuerst, um einzelne Monteure zu ändern.",
                    },
                )
            person = self._payroll_person(person_id)
            blockers = self._person_blockers(
                self._readiness_blockers(year, month, current_user),
                person_id,
            )
            predecessor = self._predecessor_blocker(year, month)
            if predecessor is not None:
                blockers.insert(0, predecessor)
            if acknowledged_blocker_count != len(blockers):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_person_month_blockers_changed",
                        "message": "Die Prüfpunkte haben sich geändert. Bitte prüfen und bestätigen Sie den aktuellen Stand erneut.",
                        "expected_blocker_count": len(blockers),
                    },
                )
            approval = self._get_or_create_person_approval(year, month, person_id)
            if approval.status != PAYROLL_PERSON_MONTH_APPROVED:
                version = approval.approval_version + 1
                reference_candidate = _person_month_reference_id(year, month, person.id, version)
                period_start = date(year, month, 1)
                period_end = date(year, month, calendar.monthrange(year, month)[1])
                export_service = PayrollMonthExportService(self.db)
                export_source = export_service.load_live_source(
                    year=year,
                    month=month,
                    current_user=current_user,
                )
                now = datetime.now(timezone.utc)
                source_snapshot = _person_source_manifest(
                    export_service.source_manifest(export_source),
                    person.id,
                )
                source_snapshot_sha256 = _sha256_json(source_snapshot)
                snapshot = _approval_blocker_snapshot(
                    blockers,
                    user_id=current_user.id,
                    acknowledged_at=now,
                    approval_version=version,
                )
                ledger_failure: dict[str, Any] | None = None
                ledger_reference_id: str | None = None
                try:
                    with self.db.begin_nested():
                        self._ledger_service().finalize_person_days(
                            person_id=person.id,
                            period_start=period_start,
                            period_end=period_end,
                            source=PAYROLL_PERSON_MONTH_SOURCE,
                            reference_id=reference_candidate,
                            created_by_user_id=current_user.id,
                        )
                    ledger_reference_id = reference_candidate
                except (HTTPException, ValueError) as error:
                    ledger_failure = _person_export_failure_details(error)
                artifact_spec = self._build_person_month_artifact(
                    person=person,
                    year=year,
                    month=month,
                    version=version,
                    ledger_reference_id=reference_candidate,
                    export_source=export_source,
                    has_finalized_ledger=ledger_reference_id is not None,
                )
                status_before = approval.status
                approval.status = PAYROLL_PERSON_MONTH_APPROVED
                approval.approval_version = version
                approval.ledger_reference_id = ledger_reference_id
                approval.blocker_snapshot_json = snapshot
                approval.approved_at = now
                approval.approved_by_user_id = current_user.id
                approval.reopened_at = None
                approval.reopened_by_user_id = None
                approval.reopen_reason = None
                period.row_version += 1
                content = artifact_spec["content"]
                content_sha256 = hashlib.sha256(content).hexdigest()
                self.db.add(
                    PayrollMonthPersonApprovalArtifact(
                        approval_id=approval.id,
                        year=year,
                        month=month,
                        person_id=person.id,
                        approval_version=version,
                        ledger_reference_id=reference_candidate,
                        filename=artifact_spec["filename"],
                        media_type=PAYROLL_XLSX_MEDIA_TYPE,
                        content=content,
                        byte_size=len(content),
                        content_sha256=content_sha256,
                    )
                )
                self.db.add(
                    PayrollMonthAudit(
                        period_id=period.id,
                        action="PERSON_MONTH_APPROVED",
                        status_before=status_before,
                        status_after=PAYROLL_PERSON_MONTH_APPROVED,
                        details_json={
                            "person_id": person.id,
                            "person_name": person.display_name,
                            "approval_version": version,
                            "ledger_reference_id": ledger_reference_id,
                            "source_snapshot": source_snapshot,
                            "source_snapshot_sha256": source_snapshot_sha256,
                            "artifact_filename": artifact_spec["filename"],
                            "artifact_content_sha256": content_sha256,
                            "export_status": "READY",
                            "export_generation_mode": artifact_spec["generation_mode"],
                            "export_generation_notice": artifact_spec.get("generation_notice"),
                            "ledger_failure": ledger_failure,
                            "blocker_count": len(snapshot),
                            "blockers": snapshot,
                        },
                        user_id=current_user.id,
                    )
                )
                AuditService(self.db).record(
                    user_id=current_user.id,
                    action="payroll_person_month.approved",
                    entity_type="payroll_month_person_approval",
                    entity_id=approval.id,
                    old_value={"status": status_before},
                    new_value={
                        "status": PAYROLL_PERSON_MONTH_APPROVED,
                        "year": year,
                        "month": month,
                        "person_id": person.id,
                        "approval_version": version,
                    },
                )
            self.db.commit()
        except Exception as error:
            self.db.rollback()
            self._raise_ledger_validation(error)
            raise
        return self.get_status(year=year, month=month, current_user=current_user)

    def reopen_person_month(
        self,
        *,
        year: int,
        month: int,
        person_id: int,
        reason: str,
        current_user: User,
    ) -> PayrollMonthStatusRead:
        _validate_month(year, month)
        _ensure_may_manage(current_user)
        reason = (reason or "").strip()
        if not reason:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eine Begründung ist Pflicht.")
        try:
            self._acquire_close_locks(year, month)
            period = self._get_or_create_locked_period_row(year, month)
            if period.status == PAYROLL_MONTH_LOCKED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_month_locked",
                        "message": "Der Gesamtmonat ist gesperrt. Öffnen Sie zuerst den Gesamtmonat.",
                    },
                )
            person = self._payroll_person(person_id)
            approval = self._person_approval_for_update(year, month, person_id)
            if approval is None or approval.status != PAYROLL_PERSON_MONTH_APPROVED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "payroll_person_month_not_approved",
                        "message": "Dieser Monteurmonat ist noch nicht abgeschlossen.",
                    },
                )
            ledger_reference_id = approval.ledger_reference_id
            now = datetime.now(timezone.utc)
            approval.status = PAYROLL_PERSON_MONTH_OPEN
            approval.reopened_at = now
            approval.reopened_by_user_id = current_user.id
            approval.reopen_reason = reason
            period.row_version += 1
            self.db.flush()
            superseded_count = 0
            if ledger_reference_id:
                period_start = date(year, month, 1)
                period_end = date(year, month, calendar.monthrange(year, month)[1])
                superseded_count = self._ledger_service().unfinalize_person_days(
                    person_id=person.id,
                    period_start=period_start,
                    period_end=period_end,
                    source=PAYROLL_PERSON_MONTH_SOURCE,
                    reference_id=ledger_reference_id,
                )
            approval.ledger_reference_id = None
            self.db.add(
                PayrollMonthAudit(
                    period_id=period.id,
                    action="PERSON_MONTH_REOPENED",
                    status_before=PAYROLL_PERSON_MONTH_APPROVED,
                    status_after=PAYROLL_PERSON_MONTH_OPEN,
                    reason=reason,
                    details_json={
                        "person_id": person.id,
                        "person_name": person.display_name,
                        "approval_version": approval.approval_version,
                        "ledger_reference_id": ledger_reference_id,
                        "superseded_ledger_entries": int(superseded_count or 0),
                    },
                    user_id=current_user.id,
                )
            )
            AuditService(self.db).record(
                user_id=current_user.id,
                action="payroll_person_month.reopened",
                entity_type="payroll_month_person_approval",
                entity_id=approval.id,
                old_value={
                    "status": PAYROLL_PERSON_MONTH_APPROVED,
                    "approval_version": approval.approval_version,
                },
                new_value={"status": PAYROLL_PERSON_MONTH_OPEN, "reason": reason},
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return self.get_status(year=year, month=month, current_user=current_user)

    def _payroll_people(self) -> list[Person]:
        return PayrollMonthExportService(self.db).payroll_people()

    def _payroll_person(self, person_id: int) -> Person:
        person = next((item for item in self._payroll_people() if item.id == person_id), None)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Monteur nicht gefunden.")
        return person

    def _person_approvals(
        self,
        year: int,
        month: int,
    ) -> dict[int, PayrollMonthPersonApproval]:
        return {
            item.person_id: item
            for item in self.db.scalars(
                select(PayrollMonthPersonApproval)
                .options(
                    selectinload(PayrollMonthPersonApproval.approved_by),
                    selectinload(PayrollMonthPersonApproval.reopened_by),
                    selectinload(PayrollMonthPersonApproval.artifacts),
                )
                .where(
                    PayrollMonthPersonApproval.year == year,
                    PayrollMonthPersonApproval.month == month,
                )
            )
        }

    def _approved_person_ids(self, year: int, month: int) -> set[int]:
        return {
            person_id
            for person_id, approval in self._person_approvals(year, month).items()
            if approval.status == PAYROLL_PERSON_MONTH_APPROVED
        }

    def _get_or_create_person_approval(
        self,
        year: int,
        month: int,
        person_id: int,
    ) -> PayrollMonthPersonApproval:
        approval = self._person_approval_for_update(year, month, person_id)
        if approval is None:
            approval = PayrollMonthPersonApproval(
                year=year,
                month=month,
                person_id=person_id,
                status=PAYROLL_PERSON_MONTH_OPEN,
                blocker_snapshot_json=[],
            )
            self.db.add(approval)
            self.db.flush()
        return approval

    def _person_approval_for_update(
        self,
        year: int,
        month: int,
        person_id: int,
    ) -> PayrollMonthPersonApproval | None:
        return self.db.scalar(
            select(PayrollMonthPersonApproval)
            .where(
                PayrollMonthPersonApproval.year == year,
                PayrollMonthPersonApproval.month == month,
                PayrollMonthPersonApproval.person_id == person_id,
            )
            .with_for_update()
        )

    def _person_approval_reads(
        self,
        *,
        year: int,
        month: int,
        people: list[Person],
        approvals: dict[int, PayrollMonthPersonApproval],
        blockers: list[PayrollMonthBlocker],
        month_status: str,
        month_locked_at: datetime | None,
        month_locked_by_name: str | None,
        month_artifacts_ready: bool,
        may_manage: bool,
    ) -> list[PayrollMonthPersonApprovalRead]:
        result: list[PayrollMonthPersonApprovalRead] = []
        is_month_locked = month_status == PAYROLL_MONTH_LOCKED
        for person in people:
            approval = approvals.get(person.id)
            stored_status = approval.status if approval else PAYROLL_PERSON_MONTH_OPEN
            status_value = PAYROLL_PERSON_MONTH_APPROVED if is_month_locked else stored_status
            current_blockers = self._person_blockers(blockers, person.id)
            display_blockers = [] if status_value == PAYROLL_PERSON_MONTH_APPROVED else current_blockers
            has_technical_blocker = bool(
                status_value == PAYROLL_PERSON_MONTH_OPEN
                and any(_is_technical_blocker(item) for item in current_blockers)
            )
            active_artifact = next(
                (
                    item for item in (approval.artifacts if approval else [])
                    if item.approval_version == (approval.approval_version if approval else 0)
                ),
                None,
            )
            export_ready = bool(
                status_value == PAYROLL_PERSON_MONTH_APPROVED
                and (month_artifacts_ready if is_month_locked else active_artifact)
            )
            result.append(
                PayrollMonthPersonApprovalRead(
                    person_id=person.id,
                    person_name=person.display_name,
                    status=status_value,
                    approval_version=approval.approval_version if approval else 0,
                    approved_at=(
                        approval.approved_at
                        if approval and approval.approved_at
                        else month_locked_at if is_month_locked else None
                    ),
                    approved_by_name=(
                        approval.approved_by.display_name
                        if approval and approval.approved_by
                        else month_locked_by_name if is_month_locked else None
                    ),
                    reopened_at=approval.reopened_at if approval else None,
                    reopened_by_name=(approval.reopened_by.display_name if approval and approval.reopened_by else None),
                    reopen_reason=approval.reopen_reason if approval else None,
                    blocker_count=len(display_blockers),
                    blockers=display_blockers,
                    has_blocking_technical_error=has_technical_blocker,
                    export_ready=export_ready,
                    export_status="READY" if export_ready else "UNAVAILABLE",
                    export_message=(
                        None
                        if export_ready or status_value == PAYROLL_PERSON_MONTH_OPEN
                        else "Der Monteurmonat ist geprüft. Die Excel-Datei konnte für diesen Stand nicht erzeugt werden."
                    ),
                    can_approve=bool(
                        may_manage
                        and month_status == PAYROLL_MONTH_OPEN
                        and status_value == PAYROLL_PERSON_MONTH_OPEN
                    ),
                    can_reopen=bool(
                        may_manage
                        and month_status == PAYROLL_MONTH_OPEN
                        and status_value == PAYROLL_PERSON_MONTH_APPROVED
                    ),
                )
            )
        return result

    @staticmethod
    def _person_blockers(
        blockers: list[PayrollMonthBlocker],
        person_id: int,
    ) -> list[PayrollMonthBlocker]:
        return [item for item in blockers if item.person_id in (None, person_id)]

    @staticmethod
    def _unresolved_month_blockers(
        blockers: list[PayrollMonthBlocker],
        approved_person_ids: set[int],
    ) -> list[PayrollMonthBlocker]:
        result: list[PayrollMonthBlocker] = []
        for blocker in blockers:
            if (
                blocker.person_id in approved_person_ids
                and not _is_technical_blocker(blocker)
            ):
                continue
            result.append(blocker)
        return result

    def _readiness_blockers(
        self,
        year: int,
        month: int,
        current_user: User,
    ) -> list[PayrollMonthBlocker]:
        if date(year, month, 1) < PAYROLL_LEDGER_CUTOVER_DATE:
            return [
                PayrollMonthBlocker(
                    code="payroll_month_before_cutover",
                    message="Der neue Monatsabschluss beginnt am 01.08.2026.",
                )
            ]
        readiness = self._ledger_service().validate_month_readiness(year=year, month=month)
        raw_blockers = getattr(readiness, "blockers", ())
        blockers = [_normalise_blocker(item) for item in raw_blockers]
        blockers.extend(self._domain_blockers(year, month, current_user))
        return blockers

    def _domain_blockers(
        self,
        year: int,
        month: int,
        current_user: User,
    ) -> list[PayrollMonthBlocker]:
        blockers: list[PayrollMonthBlocker] = []
        month_start = date(year, month, 1)
        month_end = date(year, month, calendar.monthrange(year, month)[1])
        export_service = PayrollMonthExportService(self.db)
        try:
            source = export_service.load_live_source(
                year=year,
                month=month,
                current_user=current_user,
            )
        except HTTPException as error:
            return [
                PayrollMonthBlocker(
                    code="payroll_export_source_invalid",
                    message=str(error.detail),
                )
            ]

        blockers.extend(self._weekly_review_blockers(source, month_start, month_end))
        entries = [
            entry for entry in source.entries if month_start <= entry.work_date <= month_end
        ]
        blockers.extend(self._time_entry_blockers(entries))
        blockers.extend(
            self._absence_blockers(
                source.absences,
                month_start=month_start,
                month_end=month_end,
            )
        )

        gps_service = GpsPresenceService(self.db)
        evaluations = gps_service.evaluate_time_entries(entries)
        for entry in entries:
            evaluation = evaluations.get(entry.id)
            if evaluation is None:
                continue
            if (
                TimeEntryService.is_open_time_review_case(entry, evaluation.work_minutes)
                or evaluation.has_source_mismatch
                or bool(evaluation.review_notices)
            ):
                blockers.append(
                    PayrollMonthBlocker(
                        code="open_time_or_gps_review",
                        message="Die Zeit- oder Ortsprüfung dieses Eintrags ist noch nicht eindeutig abgeschlossen.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )

        manual_site_keys = {
            (entry.person_id, entry.work_date, entry.site_id)
            for entry in entries
            if entry.site_id is not None
        }
        for stay in gps_service.list_site_stays_for_review(
            date_from=month_start,
            date_to=month_end,
        ):
            if (stay.person_id, stay.work_date, stay.site_id) not in manual_site_keys:
                blockers.append(
                    PayrollMonthBlocker(
                        code="unresolved_gps_time_entry",
                        message="Eine GPS-Erfassung besitzt noch keine zugeordnete Arbeitszeit.",
                        person_id=stay.person_id,
                        work_date=stay.work_date,
                    )
                )

        for person in source.people:
            try:
                plan = build_payroll_month_plan(
                    person=person,
                    year=year,
                    month=month,
                    entries=[item for item in source.entries if item.person_id == person.id],
                    absences=[item for item in source.absences if item.person_id == person.id],
                    non_working_dates=source.holidays,
                    work_days=[item for item in source.work_days if item.person_id == person.id],
                )
            except (ValueError, TypeError) as error:
                blockers.append(
                    PayrollMonthBlocker(
                        code="payroll_export_validation_failed",
                        message=str(error),
                        person_id=person.id,
                    )
                )
                continue
            for warning in plan.travel_expenses.warnings:
                blockers.append(
                    PayrollMonthBlocker(
                        code=f"travel_{warning.code}",
                        message="Die Reisekosten- oder Übernachtungsangabe ist nicht eindeutig.",
                        person_id=warning.person_id,
                        work_date=warning.work_date,
                    )
                )
        try:
            load_payroll_monthly_template()
        except PayrollXlsxTemplateError as error:
            blockers.append(
                PayrollMonthBlocker(
                    code="payroll_template_invalid",
                    message=str(error),
                )
            )
        return _deduplicate_blockers(blockers)

    @staticmethod
    def _time_entry_blockers(entries) -> list[PayrollMonthBlocker]:
        blockers: list[PayrollMonthBlocker] = []
        intervals: dict[int, list[tuple[int, int, Any]]] = {}
        for entry in entries:
            corrected_start = entry.payroll_corrected_start_time
            corrected_end = entry.payroll_corrected_end_time
            corrected_minutes = entry.payroll_corrected_work_minutes
            has_corrected_clock = corrected_start is not None or corrected_end is not None

            # A correction consisting only of an explicitly checked duration is
            # complete without clock values. If clock values are supplied, both
            # are mandatory and replace an incomplete original interval.
            if has_corrected_clock:
                start_time = corrected_start
                end_time = corrected_end
                break_minutes = (
                    entry.payroll_corrected_break_minutes
                    if entry.payroll_corrected_break_minutes is not None
                    else entry.break_minutes
                )
            elif corrected_minutes is not None:
                has_complete_original_clock = (
                    entry.start_time is not None and entry.end_time is not None
                )
                start_time = entry.start_time if has_complete_original_clock else None
                end_time = entry.end_time if has_complete_original_clock else None
                break_minutes = (
                    entry.payroll_corrected_break_minutes
                    if entry.payroll_corrected_break_minutes is not None
                    else entry.break_minutes
                )
            else:
                start_time = entry.start_time
                end_time = entry.end_time
                break_minutes = entry.break_minutes

            if (start_time is None) != (end_time is None):
                blockers.append(
                    PayrollMonthBlocker(
                        code="incomplete_work_interval",
                        message="Beginn und Ende der Arbeitszeit sind unvollständig.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )
                continue

            effective_minutes = (
                corrected_minutes if corrected_minutes is not None else entry.work_minutes
            )
            if effective_minutes is None or effective_minutes < 0:
                blockers.append(
                    PayrollMonthBlocker(
                        code="invalid_work_minutes",
                        message="Die Arbeitszeit enthält keinen gültigen Minutenwert.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )

            if break_minutes is not None and break_minutes < 0:
                blockers.append(
                    PayrollMonthBlocker(
                        code="invalid_break_minutes",
                        message="Die Pause darf nicht negativ sein.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )

            if start_time is None or end_time is None:
                continue
            start_minutes = start_time.hour * 60 + start_time.minute
            end_minutes = end_time.hour * 60 + end_time.minute
            if end_minutes <= start_minutes:
                end_minutes += 24 * 60
            gross_minutes = end_minutes - start_minutes
            if start_time == end_time or (break_minutes or 0) >= gross_minutes:
                blockers.append(
                    PayrollMonthBlocker(
                        code="invalid_break_or_interval",
                        message="Beginn, Ende und Pause ergeben keine plausible Arbeitszeit.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )
                continue

            absolute_start = entry.work_date.toordinal() * 24 * 60 + start_minutes
            absolute_end = entry.work_date.toordinal() * 24 * 60 + end_minutes
            intervals.setdefault(entry.person_id, []).append(
                (absolute_start, absolute_end, entry)
            )

        for person_intervals in intervals.values():
            person_intervals.sort(key=lambda item: (item[0], item[1], item[2].id or -1))
            if not person_intervals:
                continue
            previous = person_intervals[0]
            for current in person_intervals[1:]:
                if current[0] >= previous[1]:
                    previous = current
                    continue
                entry = current[2]
                blockers.append(
                    PayrollMonthBlocker(
                        code="overlapping_work_intervals",
                        message="Arbeitszeitintervalle derselben Person überschneiden sich.",
                        person_id=entry.person_id,
                        work_date=entry.work_date,
                    )
                )
                if current[1] > previous[1]:
                    previous = current
        return blockers

    @staticmethod
    def _absence_blockers(
        absences,
        *,
        month_start: date,
        month_end: date,
    ) -> list[PayrollMonthBlocker]:
        return [
            PayrollMonthBlocker(
                code="invalid_absence_range",
                message="Der Zeitraum einer aktiven Abwesenheit ist ungültig.",
                person_id=absence.person_id,
                work_date=absence.start_date,
            )
            for absence in absences
            if absence.status == AbsenceStatus.ACTIVE
            and absence.start_date <= month_end
            and absence.end_date >= month_start
            and absence.end_date < absence.start_date
        ]

    def _weekly_review_blockers(
        self,
        source: PayrollMonthSourceBundle,
        month_start: date,
        month_end: date,
    ) -> list[PayrollMonthBlocker]:
        full_weeks: list[tuple[int, int, date]] = []
        cursor = month_start
        while cursor <= month_end:
            monday = date.fromordinal(cursor.toordinal() - cursor.weekday())
            sunday = date.fromordinal(monday.toordinal() + 6)
            if monday >= month_start and sunday <= month_end:
                iso = monday.isocalendar()
                item = (iso.year, iso.week, monday)
                if item not in full_weeks:
                    full_weeks.append(item)
            cursor = date.fromordinal(cursor.toordinal() + 1)
        if not full_weeks:
            return []
        person_ids = {person.id for person in source.people}
        reviews = {
            (review.person_id, review.iso_year, review.iso_week): review
            for review in self.db.scalars(
                select(TimeEntryWeeklyReview).where(
                    TimeEntryWeeklyReview.person_id.in_(person_ids),
                    TimeEntryWeeklyReview.iso_year.in_({item[0] for item in full_weeks}),
                    TimeEntryWeeklyReview.iso_week.in_({item[1] for item in full_weeks}),
                )
            )
        }
        blockers: list[PayrollMonthBlocker] = []
        for person in source.people:
            for iso_year, iso_week, monday in full_weeks:
                review = reviews.get((person.id, iso_year, iso_week))
                if review is None or review.status != "reviewed":
                    blockers.append(
                        PayrollMonthBlocker(
                            code="payroll_week_not_reviewed",
                            message=f"KW {iso_week:02d}/{iso_year} ist noch nicht vollständig geprüft.",
                            person_id=person.id,
                            work_date=monday,
                        )
                    )
        return blockers

    def _predecessor_blocker(self, year: int, month: int) -> PayrollMonthBlocker | None:
        current = date(year, month, 1)
        if current <= PAYROLL_LEDGER_CUTOVER_DATE:
            return None
        previous_last = date.fromordinal(current.toordinal() - 1)
        previous = self._period(previous_last.year, previous_last.month)
        if previous is None or previous.status != PAYROLL_MONTH_LOCKED:
            return PayrollMonthBlocker(
                code="previous_payroll_month_not_locked",
                message=(
                    f"Der Vormonat {previous_last.month:02d}/{previous_last.year} muss zuerst abgeschlossen werden, "
                    "damit der Eröffnungssaldo lückenlos übernommen werden kann."
                ),
            )
        return None

    def _raise_blockers(self, blockers: list[PayrollMonthBlocker]) -> None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": "payroll_month_not_ready",
                "message": "Der Monat kann wegen ungeklärter Abrechnungsdaten nicht abgeschlossen werden.",
                "blockers": [item.model_dump(mode="json") for item in blockers],
            },
        )

    def _build_artifact_specs(
        self,
        *,
        export_service: PayrollMonthExportService,
        export_source,
        year: int,
        month: int,
        version: int,
        person_values: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        balances = {
            item["person_id"]: (
                item["opening_balance_minutes"],
                item["closing_balance_minutes"],
            )
            for item in person_values
        }
        people = list(export_source.people)
        person_ids = {person.id for person in people}
        if person_ids != set(balances):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_snapshot_person_mismatch",
                    "message": "Ledger und Export enthalten nicht dieselben abrechenbaren Monteure.",
                },
            )
        combined = export_service.build_all_workers_export_from_source(
            source=export_source,
            balances_by_person=balances,
        )
        specs: list[dict[str, Any]] = [
            {
                "artifact_key": "all_workers",
                "person_id": None,
                "filename": (
                    f"lohnabrechnung_{year}_{month:02d}_alle_monteure_v{version}.xlsx"
                ),
                "content": combined,
            }
        ]
        for person in people:
            opening, closing = balances[person.id]
            content = export_service.build_worker_export_from_source(
                source=export_source,
                person_id=person.id,
                opening_balance_minutes=opening,
                closing_balance_minutes=closing,
            )
            specs.append(
                {
                    "artifact_key": f"worker:{person.id}",
                    "person_id": person.id,
                    "filename": (
                        f"lohnabrechnung_{year}_{month:02d}_person_{person.id}_v{version}.xlsx"
                    ),
                    "content": content,
                }
            )
        return specs

    def _build_person_month_artifact(
        self,
        *,
        person: Person,
        year: int,
        month: int,
        version: int,
        ledger_reference_id: str,
        export_source: PayrollMonthSourceBundle,
        has_finalized_ledger: bool,
    ) -> dict[str, Any]:
        export_service = PayrollMonthExportService(self.db)
        period_start = date(year, month, 1)
        period_end = date(year, month, calendar.monthrange(year, month)[1])
        opening_balance: int | None = None
        closing_balance: int | None = None
        if has_finalized_ledger:
            opening_balance = self._ledger_service().balance_before(person.id, period_start)
            movement = self.db.scalar(
                select(func.coalesce(func.sum(PersonHoursAccountEntry.minutes_delta), 0)).where(
                    PersonHoursAccountEntry.person_id == person.id,
                    PersonHoursAccountEntry.ledger_system == "daily",
                    PersonHoursAccountEntry.is_active.is_(True),
                    PersonHoursAccountEntry.effective_date >= period_start,
                    PersonHoursAccountEntry.effective_date <= period_end,
                )
            )
            closing_balance = opening_balance + int(movement or 0)
        generation_mode = "STANDARD"
        generation_notice = None
        try:
            content = export_service.build_worker_export_from_source(
                source=export_source,
                person_id=person.id,
                opening_balance_minutes=opening_balance,
                closing_balance_minutes=closing_balance,
            )
        except Exception as error:
            generation_mode = "CONFIRMED_SOURCE_FALLBACK"
            generation_notice = _person_export_failure_details(error)
            content = export_service.build_worker_approved_state_fallback(
                source=export_source,
                person_id=person.id,
            )
        return {
            "artifact_key": f"worker:{person.id}:approval:{version}",
            "ledger_reference_id": ledger_reference_id,
            "filename": (
                f"lohnabrechnung_{year}_{month:02d}_person_{person.id}_freigabe_v{version}.xlsx"
            ),
            "content": content,
            "generation_mode": generation_mode,
            "generation_notice": generation_notice,
        }

    def _persist_artifacts(
        self,
        *,
        snapshot: PayrollMonthSnapshot,
        artifact_specs: list[dict[str, Any]],
        user_id: int,
    ) -> None:
        for item in artifact_specs:
            content = item["content"]
            self.db.add(
                PayrollMonthArtifact(
                    snapshot_id=snapshot.id,
                    artifact_key=item["artifact_key"],
                    person_id=item["person_id"],
                    filename=item["filename"],
                    media_type=PAYROLL_XLSX_MEDIA_TYPE,
                    content=content,
                    byte_size=len(content),
                    content_sha256=hashlib.sha256(content).hexdigest(),
                )
            )
            self.db.add(
                PayrollMonthAudit(
                    period_id=snapshot.period_id,
                    snapshot_id=snapshot.id,
                    action="EXPORT_CREATED",
                    status_before=PAYROLL_MONTH_OPEN,
                    status_after=PAYROLL_MONTH_LOCKED,
                    details_json={
                        "artifact_key": item["artifact_key"],
                        "filename": item["filename"],
                        "byte_size": len(content),
                        "content_sha256": hashlib.sha256(content).hexdigest(),
                    },
                    user_id=user_id,
                )
            )
        self.db.flush()

    def _artifacts_ready(self, snapshot: PayrollMonthSnapshot) -> bool:
        """Require exactly one combined workbook and one workbook per person.

        A mere non-zero artifact count is unsafe: an interrupted or manually
        damaged snapshot must never re-enable the download controls.
        """
        person_ids = set(
            self.db.scalars(
                select(PayrollMonthPersonSnapshot.person_id).where(
                    PayrollMonthPersonSnapshot.snapshot_id == snapshot.id
                )
            )
        )
        artifacts = list(
            self.db.scalars(
                select(PayrollMonthArtifact).where(
                    PayrollMonthArtifact.snapshot_id == snapshot.id
                )
            )
        )
        expected_keys = {"all_workers", *(f"worker:{person_id}" for person_id in person_ids)}
        actual_keys = {artifact.artifact_key for artifact in artifacts}
        if len(artifacts) != len(expected_keys) or actual_keys != expected_keys:
            return False
        combined = [artifact for artifact in artifacts if artifact.artifact_key == "all_workers"]
        workers = [artifact for artifact in artifacts if artifact.artifact_key != "all_workers"]
        return (
            len(combined) == 1
            and combined[0].person_id is None
            and {artifact.person_id for artifact in workers} == person_ids
            and all(
                artifact.byte_size == len(artifact.content)
                and artifact.content_sha256 == hashlib.sha256(artifact.content).hexdigest()
                for artifact in artifacts
            )
        )

    def _audit_close_failure(
        self,
        year: int,
        month: int,
        current_user: User,
        error: Exception,
    ) -> None:
        """Persist a failed close outside the rolled-back close transaction."""
        try:
            self._acquire_close_locks(year, month)
            period = self._get_or_create_locked_period_row(year, month)
            details = _failure_details(error)
            self.db.add(
                PayrollMonthAudit(
                    period_id=period.id,
                    action="MONTH_LOCK_FAILED",
                    status_before=period.status,
                    status_after=period.status,
                    details_json=details,
                    user_id=current_user.id,
                )
            )
            AuditService(self.db).record(
                user_id=current_user.id,
                action="payroll_month.lock_failed",
                entity_type="payroll_month_period",
                entity_id=period.id,
                old_value={"status": period.status},
                new_value=details,
            )
            self.db.commit()
        except Exception:
            self.db.rollback()

    def _period(self, year: int, month: int) -> PayrollMonthPeriod | None:
        return self.db.scalar(
            select(PayrollMonthPeriod)
            .options(selectinload(PayrollMonthPeriod.locked_by))
            .where(PayrollMonthPeriod.year == year, PayrollMonthPeriod.month == month)
        )

    def _current_snapshot(self, period: PayrollMonthPeriod | None) -> PayrollMonthSnapshot | None:
        if period is None or period.last_snapshot_version <= 0:
            return None
        return self.db.scalar(
            select(PayrollMonthSnapshot).where(
                PayrollMonthSnapshot.period_id == period.id,
                PayrollMonthSnapshot.version == period.last_snapshot_version,
            )
        )

    def _get_or_create_locked_period_row(self, year: int, month: int) -> PayrollMonthPeriod:
        period = self.db.scalar(
            select(PayrollMonthPeriod)
            .where(PayrollMonthPeriod.year == year, PayrollMonthPeriod.month == month)
            .with_for_update()
        )
        if period is None:
            period = PayrollMonthPeriod(year=year, month=month, status=PAYROLL_MONTH_OPEN)
            self.db.add(period)
            self.db.flush()
        return period

    def _has_later_locked_month(self, year: int, month: int) -> bool:
        key = year * 100 + month
        return bool(
            self.db.scalar(
                select(func.count(PayrollMonthPeriod.id)).where(
                    PayrollMonthPeriod.status == PAYROLL_MONTH_LOCKED,
                    PayrollMonthPeriod.year * 100 + PayrollMonthPeriod.month > key,
                )
            )
        )

    def _acquire_close_locks(self, year: int, month: int) -> None:
        guard = PayrollPeriodGuard(self.db)
        bind = self.db.get_bind()
        if bind.dialect.name == "postgresql":
            self.db.execute(
                text("SELECT pg_advisory_xact_lock(:key)"),
                {"key": PAYROLL_GLOBAL_ADVISORY_LOCK_KEY},
            )
        range_start, range_end = payroll_month_source_range(year, month)
        cursor = date(range_start.year, range_start.month, 1)
        last = date(range_end.year, range_end.month, 1)
        while cursor <= last:
            guard.acquire_month_lock(cursor.year, cursor.month)
            cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)

    def _ledger_service(self):
        # Local import avoids a circular dependency with guard-aware ledger mutations.
        from app.services.payroll_daily_ledger_service import PayrollDailyLedgerService

        return PayrollDailyLedgerService(self.db)

    def _normalise_finalization(self, result: Any) -> list[dict[str, Any]]:
        raw_people = getattr(result, "people", None)
        if raw_people is None:
            raw_people = getattr(result, "persons", None)
        if raw_people is None:
            raw_people = getattr(result, "person_results", ())
        values: list[dict[str, Any]] = []
        for raw in raw_people:
            data = _json_value(raw)
            values.append(
                {
                    "person_id": int(_first(data, "person_id")),
                    "person_name": str(_first(data, "person_name", "display_name", default=f"Person {_first(data, 'person_id')}")),
                    "opening_balance_minutes": int(_first(data, "opening_balance_minutes")),
                    "movement_minutes": int(_first(data, "movement_minutes", "month_delta_minutes", "monthly_movement_minutes")),
                    "closing_balance_minutes": int(_first(data, "closing_balance_minutes")),
                    "days": _json_value(_first(data, "daily_values", "days", "daily_entries", default=[])),
                }
            )
        values.sort(key=lambda item: (item["person_name"].casefold(), item["person_id"]))
        return values

    @staticmethod
    def _raise_ledger_validation(error: Exception) -> None:
        from app.services.payroll_daily_ledger_service import PayrollLedgerValidationError

        if isinstance(error, PayrollLedgerValidationError):
            blockers = [_normalise_blocker(item) for item in error.blockers]
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "payroll_month_not_ready",
                    "message": "Der Monat kann wegen ungeklärter Abrechnungsdaten nicht abgeschlossen werden.",
                    "blockers": [item.model_dump(mode="json") for item in blockers],
                },
            ) from error

def _validate_month(year: int, month: int) -> None:
    if year < 2000 or year > 2100 or month < 1 or month > 12:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger Abrechnungsmonat.")


def _may_manage_payroll(user: User) -> bool:
    return user.role in {UserRole.ADMIN, UserRole.PROJECT_MANAGER} or (
        user.role == UserRole.OFFICE and office_user_can_access(user, OFFICE_PAGE_PAYROLL)
    )


def _ensure_may_manage(user: User) -> None:
    if not _may_manage_payroll(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung für den Monatsabschluss.")


def _normalise_blocker(item: Any) -> PayrollMonthBlocker:
    data = _json_value(item)
    return PayrollMonthBlocker(
        code=str(_first(data, "code", default="payroll_readiness_blocker")),
        message=str(_first(data, "message", default="Ungeklärte Abrechnungsdaten.")),
        person_id=_optional_int(data.get("person_id")),
        work_date=_optional_date(data.get("work_date") or data.get("date")),
        work_date_end=_optional_date(data.get("work_date_end")),
    )


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, (Enum,)):
        return value.value
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "__dict__"):
        return {
            key: _json_value(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return value


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(_json_value(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _first(data: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in data:
            return data[name]
    if default is not None:
        return default
    raise KeyError(names[0])


def _optional_int(value: Any) -> int | None:
    return int(value) if value is not None else None


def _optional_date(value: Any) -> date | None:
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _failure_details(error: Exception) -> dict[str, Any]:
    if isinstance(error, HTTPException):
        detail = error.detail
        return {
            "status_code": error.status_code,
            "detail": _json_value(detail),
        }
    try:
        from app.services.payroll_daily_ledger_service import PayrollLedgerValidationError

        if isinstance(error, PayrollLedgerValidationError):
            return {
                "code": "payroll_month_not_ready",
                "blockers": [_json_value(item) for item in error.blockers],
            }
    except ImportError:
        pass
    return {
        "code": "payroll_month_close_failed",
        "error_type": type(error).__name__,
        # Never persist database statements, credentials or arbitrary exception text.
        "message": "Der Monatsabschluss ist fehlgeschlagen und wurde vollständig zurückgerollt.",
    }


def _is_technical_blocker(blocker: PayrollMonthBlocker) -> bool:
    return blocker.code in PERSON_MONTH_TECHNICAL_BLOCKER_CODES


def _approval_blocker_snapshot(
    blockers: list[PayrollMonthBlocker],
    *,
    user_id: int,
    acknowledged_at: datetime,
    approval_version: int,
) -> list[dict[str, Any]]:
    return [
        item.model_dump(mode="json")
        | {
            "previous_status": PAYROLL_PERSON_MONTH_OPEN,
            "new_status": PERSON_MONTH_APPROVAL_STATUS,
            "acknowledged_by_user_id": user_id,
            "acknowledged_at": acknowledged_at.isoformat(),
            "approval_version": approval_version,
        }
        for item in blockers
    ]


def _person_month_reference_id(year: int, month: int, person_id: int, version: int) -> str:
    return f"payroll-person-month:{year:04d}-{month:02d}:person:{person_id}:v{version}"


def _person_source_manifest(source: dict[str, Any], person_id: int) -> dict[str, Any]:
    """Retain every workbook input for one worker without unrelated staff data."""

    result = dict(source)
    result["people"] = [item for item in source.get("people", []) if item.get("id") == person_id]
    result["entries"] = [item for item in source.get("entries", []) if item.get("person_id") == person_id]
    result["absences"] = [item for item in source.get("absences", []) if item.get("person_id") == person_id]
    result["work_days"] = [item for item in source.get("work_days", []) if item.get("person_id") == person_id]
    return result


def _person_export_failure_details(error: Exception) -> dict[str, Any]:
    details = _failure_details(error)
    return {
        "code": str(details.get("code") or "payroll_person_month_export_unavailable"),
        "error_type": type(error).__name__,
        "message": "Die Freigabe wurde gespeichert, die Excel-Datei konnte für diesen Stand jedoch nicht erzeugt werden.",
        "details": details,
    }


def _deduplicate_blockers(
    blockers: list[PayrollMonthBlocker],
) -> list[PayrollMonthBlocker]:
    result: list[PayrollMonthBlocker] = []
    seen: set[tuple[str, str, int | None, date | None, date | None]] = set()
    for blocker in blockers:
        key = (blocker.code, blocker.message, blocker.person_id, blocker.work_date, blocker.work_date_end)
        if key not in seen:
            seen.add(key)
            result.append(blocker)
    return result
