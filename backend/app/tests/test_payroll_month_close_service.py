from __future__ import annotations

import hashlib
from datetime import date, datetime, time, timezone
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import AbsenceStatus, PersonType, UserRole
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
from app.schemas.payroll_month import PayrollMonthBlocker
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.services.audit_service import AuditService
from app.services.payroll_month_account_service import MONTHLY, REVERSAL, TRANSITION
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.payroll_period_guard import PayrollPeriodGuard


def test_guard_rejects_locked_date_and_range_with_stable_conflict_detail():
    db = database()
    locked_at = datetime(2026, 9, 3, 8, 30, tzinfo=timezone.utc)
    db.add(
        PayrollMonthPeriod(
            year=2026,
            month=8,
            status=PAYROLL_MONTH_LOCKED,
            locked_at=locked_at,
        )
    )
    db.commit()

    for mutation in (
        lambda: PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 17)),
        lambda: PayrollPeriodGuard(db).assert_range_mutable(date(2026, 7, 31), date(2026, 8, 1)),
    ):
        with pytest.raises(HTTPException) as caught:
            mutation()
        assert caught.value.status_code == 409
        assert caught.value.detail["locked_at"].startswith("2026-09-03T08:30:00")
        assert {key: value for key, value in caught.value.detail.items() if key != "locked_at"} == {
            "code": "payroll_month_locked",
            "year": 2026,
            "month": 8,
            "message": (
                "Der Abrechnungsmonat 08/2026 ist abgeschlossen und kann nicht "
                "verändert werden. Öffnen Sie ihn zuerst in der Monatsauswertung wieder."
            ),
        }


def test_close_validation_rejects_overlaps_and_invalid_breaks_but_accepts_duration_correction():
    common = {
        "payroll_corrected_start_time": None,
        "payroll_corrected_end_time": None,
        "payroll_corrected_break_minutes": None,
        "payroll_corrected_work_minutes": None,
    }
    entries = [
        SimpleNamespace(
            **common,
            id=1,
            person_id=11,
            work_date=date(2026, 8, 3),
            start_time=time(8),
            end_time=time(12),
            break_minutes=30,
            work_minutes=210,
        ),
        SimpleNamespace(
            **common,
            id=2,
            person_id=11,
            work_date=date(2026, 8, 3),
            start_time=time(11),
            end_time=time(13),
            break_minutes=0,
            work_minutes=120,
        ),
        SimpleNamespace(
            **common,
            id=3,
            person_id=12,
            work_date=date(2026, 8, 3),
            start_time=time(8),
            end_time=time(9),
            break_minutes=60,
            work_minutes=0,
        ),
        SimpleNamespace(
            **(
                common
                | {
                    "id": 4,
                    "person_id": 13,
                    "work_date": date(2026, 8, 3),
                    "start_time": time(8),
                    "end_time": None,
                    "break_minutes": 0,
                    "work_minutes": 0,
                    "payroll_corrected_work_minutes": 120,
                }
            )
        ),
        SimpleNamespace(
            **(
                common
                | {
                    "id": 5,
                    "person_id": 14,
                    "work_date": date(2026, 8, 3),
                    "start_time": time(8),
                    "end_time": time(9),
                    "break_minutes": 0,
                    "work_minutes": 60,
                    "payroll_corrected_start_time": time(8),
                }
            )
        ),
    ]

    blockers = PayrollMonthCloseService._time_entry_blockers(entries)

    assert {(item.code, item.person_id) for item in blockers} == {
        ("overlapping_work_intervals", 11),
        ("invalid_break_or_interval", 12),
        ("incomplete_work_interval", 14),
    }
    assert all(item.person_id != 13 for item in blockers)


def test_close_validation_rejects_reversed_active_absence_range():
    blockers = PayrollMonthCloseService._absence_blockers(
        [
            SimpleNamespace(
                person_id=7,
                status=AbsenceStatus.ACTIVE,
                start_date=date(2026, 8, 20),
                end_date=date(2026, 8, 10),
            ),
            SimpleNamespace(
                person_id=8,
                status=AbsenceStatus.CANCELLED,
                start_date=date(2026, 8, 20),
                end_date=date(2026, 8, 10),
            ),
        ],
        month_start=date(2026, 8, 1),
        month_end=date(2026, 8, 31),
    )

    assert [(item.code, item.person_id) for item in blockers] == [("invalid_absence_range", 7)]


def test_weekly_review_blockers_exclude_week_crossing_into_next_month():
    db = database()
    _admin, worker = payroll_users(db)

    blockers = PayrollMonthCloseService(db)._weekly_review_blockers(
        SimpleNamespace(people=(worker,)),
        date(2026, 8, 1),
        date(2026, 8, 31),
    )

    assert [item.work_date for item in blockers] == [
        date(2026, 8, 3),
        date(2026, 8, 10),
        date(2026, 8, 17),
        date(2026, 8, 24),
    ]
    assert date(2026, 8, 31) not in {item.work_date for item in blockers}


def test_person_month_approval_acknowledges_worker_blockers_and_allows_month_lock(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    blocker = PayrollMonthBlocker(
        code="payroll_week_not_reviewed",
        message="KW 32/2026 ist noch nicht vollständig geprüft.",
        person_id=worker.id,
        work_date=date(2026, 8, 3),
    )
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [blocker])
    monkeypatch.setattr(
        service,
        "_build_person_month_artifact",
        lambda **_kwargs: {
            "filename": "worker-v1.xlsx",
            "content": b"worker-v1",
            "generation_mode": "STANDARD",
        },
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    status_read = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=1,
        current_user=admin,
    )

    approval = db.scalar(select(PayrollMonthPersonApproval))
    assert approval is not None
    assert approval.status == PAYROLL_PERSON_MONTH_APPROVED
    assert approval.approval_version == 1
    assert approval.ledger_reference_id == (f"payroll-person-month:2026-08:person:{worker.id}:v1")
    assert approval.blocker_snapshot_json[0]["new_status"] == (
        "ACKNOWLEDGED_BY_PERSON_MONTH_APPROVAL"
    )
    assert approval.blocker_snapshot_json[0]["acknowledged_by_user_id"] == admin.id
    assert approval.blocker_snapshot_json[0]["approval_version"] == 1
    assert approval.blocker_snapshot_json[0]["acknowledged_at"]
    assert status_read.can_lock is True
    assert status_read.person_approval_summary is not None
    assert status_read.person_approval_summary.approved_count == 1
    assert status_read.person_approval_summary.total_count == 1
    assert status_read.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED
    assert status_read.person_approvals[0].blocker_count == 0
    assert status_read.person_approvals[0].blockers == []
    assert status_read.person_approvals[0].export_ready is True
    account_rows = list(
        db.scalars(select(PersonHoursAccountEntry).order_by(PersonHoursAccountEntry.id))
    )
    assert [row.entry_type for row in account_rows] == [TRANSITION, MONTHLY]
    assert account_rows[0].balance_after_minutes == 0
    assert account_rows[1].source_reference_id == approval.ledger_reference_id
    assert account_rows[1].source_payload["movement_minutes"] == -(168 * 60)
    assert account_rows[1].source_payload["opening_balance_minutes"] == 0
    assert account_rows[1].source_payload["closing_balance_minutes"] == -(168 * 60)
    assert list(db.scalars(select(PayrollMonthAudit.action))) == ["PERSON_MONTH_APPROVED"]
    audit = db.scalar(select(PayrollMonthAudit))
    assert audit is not None
    assert audit.details_json["blocker_count"] == 1
    assert audit.details_json["source_snapshot_sha256"]
    assert audit.details_json["export_status"] == "READY"


def test_person_month_approval_accepts_technical_blockers_and_keeps_export_available(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    blocker = PayrollMonthBlocker(
        code="incomplete_work_interval",
        message="Beginn und Ende der Arbeitszeit sind unvollständig.",
        person_id=worker.id,
        work_date=date(2026, 8, 5),
    )
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [blocker])
    monkeypatch.setattr(
        service,
        "_build_person_month_artifact",
        lambda **_kwargs: {
            "filename": "worker-v1.xlsx",
            "content": b"worker-v1",
            "generation_mode": "STANDARD",
        },
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    approved = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=1,
        current_user=admin,
    )

    assert approved.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED
    assert approved.person_approvals[0].blockers == []
    assert approved.person_approvals[0].export_ready is True
    assert db.scalar(select(PayrollMonthPersonApprovalArtifact)) is not None
    assert (
        PayrollMonthExportService(db).worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            current_user=admin,
        )
        == b"worker-v1"
    )


def test_open_predecessor_is_not_added_to_person_month_hints(monkeypatch):
    db = database()
    _admin, worker = payroll_users(db)
    office_user = User(
        username="office-payroll",
        display_name="Lohnbüro",
        password_hash="test",
        role=UserRole.OFFICE,
        is_active=True,
        must_change_password=False,
        office_page_permissions=["payroll"],
        person_id=None,
    )
    db.add(office_user)
    db.commit()
    service = PayrollMonthCloseService(db)
    blockers = [
        PayrollMonthBlocker(
            code="payroll_week_not_reviewed",
            message=f"Prüfhinweis {index + 1}",
            person_id=worker.id,
            work_date=date(2026, 9, 1 + index),
        )
        for index in range(7)
    ]
    monkeypatch.setattr(service, "_domain_blockers", lambda *_args: list(blockers))
    monkeypatch.setattr(
        service,
        "_build_person_month_artifact",
        lambda **_kwargs: {
            "filename": "worker-v1.xlsx",
            "content": b"worker-v1",
            "generation_mode": "STANDARD",
        },
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    open_status = service.get_status(year=2026, month=9, current_user=office_user)

    assert open_status.person_approvals[0].blocker_count == 7
    assert open_status.person_approvals[0].can_approve is True
    assert not any(
        item.code == "previous_payroll_month_not_locked"
        for item in open_status.person_approvals[0].blockers
    )

    approved = service.approve_person_month(
        year=2026,
        month=9,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=7,
        current_user=office_user,
    )

    assert approved.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED
    assert approved.person_approvals[0].blockers == []


def test_person_month_standard_export_failure_rolls_back_account_and_approval(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    fallback_called = False

    def fail_standard_export(_export_service, **_values):
        raise RuntimeError("Standardexport fehlgeschlagen")

    def forbidden_fallback(*_args, **_kwargs):
        nonlocal fallback_called
        fallback_called = True
        return b"fallback-xlsx"

    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(
        PayrollMonthExportService,
        "build_worker_export_from_source",
        fail_standard_export,
    )
    monkeypatch.setattr(
        PayrollMonthExportService,
        "build_worker_approved_state_fallback",
        forbidden_fallback,
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    with pytest.raises(RuntimeError, match="Standardexport fehlgeschlagen"):
        service.approve_person_month(
            year=2026,
            month=8,
            person_id=worker.id,
            confirmed=True,
            acknowledged_blocker_count=0,
            current_user=admin,
        )

    assert fallback_called is False
    assert db.scalar(select(PayrollMonthPersonApproval.id)) is None
    assert db.scalar(select(PayrollMonthPersonApprovalArtifact.id)) is None
    assert db.scalar(select(PersonHoursAccountEntry.id)) is None
    assert db.scalar(select(PayrollMonthPeriod.id)) is None


def test_missing_account_and_contract_hours_keep_normal_export_available():
    db = database()
    admin, worker = payroll_users(db)
    worker.weekly_hours = None
    _mark_august_weeks_reviewed(db, worker, admin)
    db.commit()
    service = PayrollMonthCloseService(db)

    open_status = service.get_status(year=2026, month=8, current_user=admin)
    assert open_status.blockers == []
    assert open_status.person_approvals[0].can_approve is True

    approved = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        current_user=admin,
    )

    approval = db.scalar(select(PayrollMonthPersonApproval))
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    posting = db.scalar(
        select(PersonHoursAccountEntry).where(PersonHoursAccountEntry.entry_type == MONTHLY)
    )
    assert approval is not None and approval.ledger_reference_id
    assert artifact is not None
    assert posting is not None
    assert posting.minutes_delta == 0
    assert posting.balance_after_minutes is None
    assert posting.source_payload["movement_minutes"] is None
    assert posting.source_payload["pending_reason"].startswith("Vertragswochenstunden fehlen")
    assert approved.person_approvals[0].export_ready is True
    with ZipFile(BytesIO(artifact.content)) as workbook:
        assert workbook.testzip() is None
        worksheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
    assert "Anna Bau" in worksheet
    assert "August 26" in worksheet
    assert "Freigegebener Monteurmonat" not in worksheet


def test_person_month_reopen_requires_reason_and_reverses_exact_monthly_posting(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(
        service,
        "_build_person_month_artifact",
        lambda **_kwargs: {
            "filename": "worker-v1.xlsx",
            "content": b"worker-v1",
            "generation_mode": "STANDARD",
        },
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    approved = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        current_user=admin,
    )
    assert approved.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED
    original = db.scalar(
        select(PersonHoursAccountEntry).where(PersonHoursAccountEntry.entry_type == MONTHLY)
    )
    assert original is not None
    original_delta = original.minutes_delta

    with pytest.raises(HTTPException) as missing_reason:
        service.reopen_person_month(
            year=2026,
            month=8,
            person_id=worker.id,
            reason=" ",
            current_user=admin,
        )
    assert missing_reason.value.status_code == 400

    reopened = service.reopen_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        reason="Stundenkorrektur nach Rückfrage",
        current_user=admin,
    )

    approval = db.scalar(select(PayrollMonthPersonApproval))
    assert approval is not None
    assert approval.status == PAYROLL_PERSON_MONTH_OPEN
    assert approval.ledger_reference_id is None
    assert approval.reopen_reason == "Stundenkorrektur nach Rückfrage"
    assert reopened.can_lock is False
    assert reopened.person_approvals[0].can_approve is True
    db.refresh(original)
    reversal = db.scalar(
        select(PersonHoursAccountEntry).where(PersonHoursAccountEntry.entry_type == REVERSAL)
    )
    assert original.is_active is False
    assert reversal is not None
    assert reversal.minutes_delta == -original_delta
    assert reversal.source_reference_id == original.source_reference_id
    assert reversal.source_payload == {"reversed_entry_id": original.id}
    assert list(db.scalars(select(PayrollMonthAudit.action).order_by(PayrollMonthAudit.id))) == [
        "PERSON_MONTH_APPROVED",
        "PERSON_MONTH_REOPENED",
    ]


def test_historical_person_approval_without_monthly_posting_uses_old_ledger_reversal(
    monkeypatch,
):
    db = database()
    admin, worker = payroll_users(db)
    approval = approve_person_month_for_test(db, worker)
    legacy_reference = approval.ledger_reference_id
    ledger = FakePersonLedger()
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(service, "_ledger_service", lambda: ledger)
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    service.reopen_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        reason="Historischen Tagesabschluss korrigieren",
        current_user=admin,
    )

    assert ledger.unfinalized_calls == [
        {
            "person_id": worker.id,
            "period_start": date(2026, 8, 1),
            "period_end": date(2026, 8, 31),
            "source": "payroll_person_month_close",
            "reference_id": legacy_reference,
        }
    ]
    assert (
        db.scalar(
            select(PersonHoursAccountEntry.id).where(PersonHoursAccountEntry.entry_type == REVERSAL)
        )
        is None
    )


def test_month_lock_requires_every_person_month_approved(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as caught:
        service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_month_not_ready"
    assert caught.value.detail["blockers"][0]["code"] == "payroll_person_month_not_approved"
    assert caught.value.detail["blockers"][0]["person_id"] == worker.id


def test_person_month_approval_locks_person_mutations_until_reopened():
    db = database()
    _admin, worker = payroll_users(db)
    approve_person_month_for_test(db, worker)

    with pytest.raises(HTTPException) as caught:
        PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 12), person_id=worker.id)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_person_month_locked"
    assert caught.value.detail["person_id"] == worker.id
    PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 12), person_id=worker.id + 100)


def test_lock_reopen_and_relock_retain_person_workbooks_without_double_posting(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        current_user=admin,
    )
    first_person_artifact = db.scalar(
        select(PayrollMonthPersonApprovalArtifact).where(
            PayrollMonthPersonApprovalArtifact.approval_version == 1
        )
    )
    assert first_person_artifact is not None
    account_row_count_before_lock = len(list(db.scalars(select(PersonHoursAccountEntry.id))))

    first = service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)
    assert first.status == PAYROLL_MONTH_LOCKED
    assert first.snapshot_version == 1
    assert first.artifacts_ready is True
    assert first.person_approvals[0].export_ready is True
    assert len(list(db.scalars(select(PersonHoursAccountEntry.id)))) == (
        account_row_count_before_lock
    )
    first_snapshot = db.scalar(
        select(PayrollMonthSnapshot).where(PayrollMonthSnapshot.version == 1)
    )
    assert first_snapshot is not None
    first_worker_artifact = db.scalar(
        select(PayrollMonthArtifact).where(
            PayrollMonthArtifact.snapshot_id == first_snapshot.id,
            PayrollMonthArtifact.artifact_key == f"worker:{worker.id}",
        )
    )
    first_combined_artifact = db.scalar(
        select(PayrollMonthArtifact).where(
            PayrollMonthArtifact.snapshot_id == first_snapshot.id,
            PayrollMonthArtifact.artifact_key == "all_workers",
        )
    )
    assert first_worker_artifact is not None
    assert first_combined_artifact is not None
    assert first_worker_artifact.content == first_person_artifact.content
    assert _worksheet(first_combined_artifact.content) == _worksheet(first_person_artifact.content)

    opened = service.reopen_month(
        year=2026,
        month=8,
        reason="Korrektur eines geprüften Zeiteintrags",
        current_user=admin,
    )
    assert opened.status == PAYROLL_MONTH_OPEN
    assert opened.snapshot_version == 1
    assert opened.artifacts_ready is False

    service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        current_user=admin,
    )
    second_person_artifact = db.scalar(
        select(PayrollMonthPersonApprovalArtifact).where(
            PayrollMonthPersonApprovalArtifact.approval_version == 2
        )
    )
    assert second_person_artifact is not None
    second = service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)
    assert second.status == PAYROLL_MONTH_LOCKED
    assert second.snapshot_version == 2
    assert second.artifacts_ready is True
    assert second.person_approvals[0].export_ready is True

    snapshots = list(
        db.scalars(select(PayrollMonthSnapshot).order_by(PayrollMonthSnapshot.version))
    )
    assert [item.version for item in snapshots] == [1, 2]
    artifacts_rows = list(
        db.scalars(select(PayrollMonthArtifact).order_by(PayrollMonthArtifact.id))
    )
    assert [item.filename for item in artifacts_rows] == [
        "lohnabrechnung_2026_08_alle_monteure_v1.xlsx",
        f"lohnabrechnung_2026_08_person_{worker.id}_v1.xlsx",
        "lohnabrechnung_2026_08_alle_monteure_v2.xlsx",
        f"lohnabrechnung_2026_08_person_{worker.id}_v2.xlsx",
    ]
    assert len(list(db.scalars(select(PayrollMonthPersonSnapshot)))) == 2
    actions = list(db.scalars(select(PayrollMonthAudit.action).order_by(PayrollMonthAudit.id)))
    assert actions == [
        "PERSON_MONTH_APPROVED",
        "EXPORT_CREATED",
        "EXPORT_CREATED",
        "MONTH_LOCKED",
        "MONTH_REOPENED",
        "PERSON_MONTH_APPROVED",
        "EXPORT_CREATED",
        "EXPORT_CREATED",
        "MONTH_RELOCKED",
    ]
    account_rows = list(
        db.scalars(select(PersonHoursAccountEntry).order_by(PersonHoursAccountEntry.id))
    )
    assert [row.entry_type for row in account_rows] == [
        TRANSITION,
        MONTHLY,
        REVERSAL,
        MONTHLY,
    ]
    assert account_rows[1].is_active is False
    assert account_rows[2].minutes_delta == -account_rows[1].minutes_delta
    assert account_rows[3].is_active is True

    export_service = PayrollMonthExportService(db)
    assert (
        export_service.worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            version=2,
            current_user=admin,
        )
        == second_person_artifact.content
    )
    with pytest.raises(HTTPException) as stale:
        export_service.worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            version=1,
            current_user=admin,
        )
    assert stale.value.status_code == 409
    assert stale.value.detail["code"] == "payroll_snapshot_version_stale"


def test_artifacts_ready_requires_complete_set_and_download_checks_hash(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    period = PayrollMonthPeriod(
        year=2026,
        month=8,
        status=PAYROLL_MONTH_LOCKED,
        last_snapshot_version=1,
        locked_at=datetime.now(timezone.utc),
        locked_by_user_id=admin.id,
    )
    db.add(period)
    db.flush()
    snapshot = PayrollMonthSnapshot(
        period_id=period.id,
        version=1,
        reference_id="payroll-month:2026-08:v1",
        period_start=date(2026, 8, 1),
        period_end=date(2026, 8, 31),
        cutover_date=date(2026, 8, 1),
        payload_json={},
        payload_sha256="0" * 64,
    )
    db.add(snapshot)
    db.flush()
    db.add(
        PayrollMonthPersonSnapshot(
            snapshot_id=snapshot.id,
            person_id=worker.id,
            person_name=worker.display_name,
            opening_balance_minutes=0,
            movement_minutes=0,
            closing_balance_minutes=0,
            daily_values_json=[],
            source_sha256="0" * 64,
        )
    )
    db.add(
        PayrollMonthArtifact(
            snapshot_id=snapshot.id,
            artifact_key="all_workers",
            filename="all_v1.xlsx",
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content=b"all",
            byte_size=3,
            content_sha256="5ef5ef0364b6939c4ca61f34b393f7b368d1be8619647aaf83d5b395919ab629",
        )
    )
    db.commit()

    assert service.get_status(year=2026, month=8, current_user=admin).artifacts_ready is False

    corrupt = PayrollMonthArtifact(
        snapshot_id=snapshot.id,
        artifact_key=f"worker:{worker.id}",
        person_id=worker.id,
        filename=f"worker_{worker.id}_v1.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content=b"worker",
        byte_size=6,
        content_sha256="not-the-content-hash",
    )
    db.add(corrupt)
    db.commit()
    assert service.get_status(year=2026, month=8, current_user=admin).artifacts_ready is False
    with pytest.raises(HTTPException) as caught:
        PayrollMonthExportService(db).worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            version=1,
            current_user=admin,
        )
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_artifact_corrupt"


def test_project_manager_can_approve_and_reopen_person_month_without_assignment(monkeypatch):
    db = database()
    _admin, worker = payroll_users(db)
    project_manager = User(
        username="project-payroll",
        display_name="Projektleitung",
        password_hash="test",
        role=UserRole.PROJECT_MANAGER,
        is_active=True,
        must_change_password=False,
        person_id=None,
    )
    db.add(project_manager)
    db.commit()
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(
        service,
        "_build_person_month_artifact",
        lambda **_kwargs: {
            "filename": "worker-v1.xlsx",
            "content": b"worker-v1",
            "generation_mode": "STANDARD",
        },
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    open_status = service.get_status(year=2026, month=8, current_user=project_manager)
    assert open_status.person_approvals[0].can_approve is True

    approved = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        current_user=project_manager,
    )
    reopened = service.reopen_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        reason="Korrektur durch Projektleitung",
        current_user=project_manager,
    )

    assert approved.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED
    assert reopened.person_approvals[0].status == PAYROLL_PERSON_MONTH_OPEN
    account_rows = list(
        db.scalars(select(PersonHoursAccountEntry).order_by(PersonHoursAccountEntry.id))
    )
    assert [row.entry_type for row in account_rows] == [
        TRANSITION,
        MONTHLY,
        REVERSAL,
    ]
    assert account_rows[2].minutes_delta == -account_rows[1].minutes_delta
    assert list(db.scalars(select(PayrollMonthAudit.action).order_by(PayrollMonthAudit.id))) == [
        "PERSON_MONTH_APPROVED",
        "PERSON_MONTH_REOPENED",
    ]


@pytest.mark.parametrize(
    ("role", "permissions"),
    [
        (UserRole.OFFICE, []),
        (UserRole.MONTEUR, []),
    ],
)
def test_users_without_general_payroll_permission_cannot_manage_month(role, permissions):
    db = database()
    unauthorized_user = User(
        username=f"unauthorized-{role.value}",
        display_name="Ohne Lohnprüfungsrecht",
        password_hash="test",
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=permissions,
    )
    db.add(unauthorized_user)
    db.commit()
    service = PayrollMonthCloseService(db)

    with pytest.raises(HTTPException) as lock_error:
        service.lock_month(
            year=2026,
            month=8,
            confirmed=True,
            current_user=unauthorized_user,
        )
    assert lock_error.value.status_code == 403

    with pytest.raises(HTTPException) as reopen_error:
        service.reopen_month(
            year=2026,
            month=8,
            reason="Nicht berechtigt",
            current_user=unauthorized_user,
        )
    assert reopen_error.value.status_code == 403


def test_older_month_cannot_reopen_while_later_month_is_locked():
    db = database()
    admin, _worker = payroll_users(db)
    db.add_all(
        [
            PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_LOCKED),
            PayrollMonthPeriod(year=2026, month=9, status=PAYROLL_MONTH_LOCKED),
        ]
    )
    db.commit()

    with pytest.raises(HTTPException) as caught:
        PayrollMonthCloseService(db).reopen_month(
            year=2026,
            month=8,
            reason="Korrektur",
            current_user=admin,
        )

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_later_month_locked"


def test_older_person_month_cannot_reopen_while_later_person_month_is_approved():
    db = database()
    admin, worker = payroll_users(db)
    august = approve_person_month_for_test(db, worker, month=8)
    approve_person_month_for_test(db, worker, month=9)

    with pytest.raises(HTTPException) as caught:
        PayrollMonthCloseService(db).reopen_person_month(
            year=2026,
            month=8,
            person_id=worker.id,
            reason="Älteren Monat korrigieren",
            current_user=admin,
        )

    assert caught.value.status_code == 409
    assert "Spätere Monteurmonate" in caught.value.detail
    db.refresh(august)
    assert august.status == PAYROLL_PERSON_MONTH_APPROVED


def test_incompatible_approved_workbook_rolls_back_global_snapshot_and_artifacts(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)
    approval = approve_person_month_for_test(db, worker)
    broken_content = b"stored but not a normal xlsx"
    db.add(
        PayrollMonthPersonApprovalArtifact(
            approval_id=approval.id,
            year=2026,
            month=8,
            person_id=worker.id,
            approval_version=approval.approval_version,
            ledger_reference_id=approval.ledger_reference_id,
            filename="broken.xlsx",
            media_type=("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            content=broken_content,
            byte_size=len(broken_content),
            content_sha256=hashlib.sha256(broken_content).hexdigest(),
        )
    )
    db.commit()

    with pytest.raises(HTTPException) as caught:
        service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_approved_workbooks_incompatible"

    period = db.scalar(
        select(PayrollMonthPeriod).where(
            PayrollMonthPeriod.year == 2026,
            PayrollMonthPeriod.month == 8,
        )
    )
    assert period is not None
    assert period.status == PAYROLL_MONTH_OPEN
    assert db.scalar(select(PayrollMonthSnapshot.id)) is None
    assert db.scalar(select(PayrollMonthArtifact.id)) is None
    assert list(db.scalars(select(PayrollMonthAudit.action))) == ["MONTH_LOCK_FAILED"]


class FakePersonLedger:
    def __init__(self) -> None:
        self.unfinalized_calls: list[dict] = []

    def unfinalize_person_days(self, **values):
        self.unfinalized_calls.append(values)
        return 1


def _worksheet(content: bytes, index: int = 1) -> bytes:
    with ZipFile(BytesIO(content)) as workbook:
        return workbook.read(f"xl/worksheets/sheet{index}.xml")


def _mark_august_weeks_reviewed(db: Session, worker: Person, reviewer: User) -> None:
    reviewed_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    db.add_all(
        [
            TimeEntryWeeklyReview(
                person_id=worker.id,
                iso_year=2026,
                iso_week=iso_week,
                status="reviewed",
                reviewed_by_user_id=reviewer.id,
                reviewed_at=reviewed_at,
            )
            for iso_week in (32, 33, 34, 35)
        ]
    )


def database() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def approve_person_month_for_test(
    db: Session,
    worker: Person,
    *,
    year: int = 2026,
    month: int = 8,
) -> PayrollMonthPersonApproval:
    approval = db.scalar(
        select(PayrollMonthPersonApproval).where(
            PayrollMonthPersonApproval.year == year,
            PayrollMonthPersonApproval.month == month,
            PayrollMonthPersonApproval.person_id == worker.id,
        )
    )
    if approval is None:
        approval = PayrollMonthPersonApproval(
            year=year,
            month=month,
            person_id=worker.id,
            approval_version=1,
            blocker_snapshot_json=[],
        )
        db.add(approval)
    approval.status = PAYROLL_PERSON_MONTH_APPROVED
    approval.ledger_reference_id = f"test-person-month:{year}-{month}:{worker.id}"
    db.commit()
    return approval


def payroll_users(db: Session) -> tuple[User, Person]:
    worker = Person(
        first_name="Anna",
        last_name="Bau",
        display_name="Anna Bau",
        short_code="AB",
        person_type=PersonType.INTERNAL,
        is_active=True,
        weekly_hours=40,
    )
    admin = User(
        username="admin-payroll",
        display_name="Lohnbüro",
        password_hash="test",
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )
    db.add_all([worker, admin])
    db.commit()
    return admin, worker
