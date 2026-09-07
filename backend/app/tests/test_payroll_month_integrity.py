from __future__ import annotations

import hashlib
from datetime import date

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.api.routes import exports, payroll_months
from app.models.enums import PersonType, UserRole
from app.models.payroll_month import (
    PAYROLL_MONTH_OPEN,
    PAYROLL_PERSON_MONTH_APPROVED,
    PayrollMonthAudit,
    PayrollMonthPeriod,
    PayrollMonthPersonApproval,
    PayrollMonthPersonApprovalArtifact,
)
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.payroll_month import (
    PayrollMonthBlocker,
    PayrollMonthPersonApprovalRequest,
)
from app.services.audit_service import AuditService
from app.services.payroll_month_close_service import (
    PayrollMonthCloseService,
    _blocker_fingerprint,
)
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.tests.test_payroll_month_close_service import database, payroll_users


def test_blocker_fingerprint_is_order_independent_and_rejects_same_count_replacement(
    monkeypatch,
):
    first = PayrollMonthBlocker(
        code="open_time_or_gps_review",
        message="Erster fachlicher Hinweis",
        person_id=1,
        work_date=date(2026, 8, 3),
    )
    second = PayrollMonthBlocker(
        code="payroll_week_not_reviewed",
        message="Zweiter fachlicher Hinweis",
        person_id=1,
        work_date=date(2026, 8, 10),
    )
    assert _blocker_fingerprint([first, second]) == _blocker_fingerprint(
        [second, first]
    )
    assert _blocker_fingerprint([first]) != _blocker_fingerprint([second])
    with pytest.raises(ValidationError):
        PayrollMonthPersonApprovalRequest(
            confirmed=True,
            acknowledged_blocker_count=1,
        )

    db = database()
    admin, worker = payroll_users(db)
    first.person_id = worker.id
    second.person_id = worker.id
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [second])

    with pytest.raises(HTTPException) as caught:
        service.approve_person_month(
            year=2026,
            month=8,
            person_id=worker.id,
            confirmed=True,
            acknowledged_blocker_count=1,
            acknowledged_blocker_fingerprint=_blocker_fingerprint([first]),
            current_user=admin,
        )

    assert caught.value.status_code == 409
    assert caught.value.detail == {
        "code": "payroll_person_month_blockers_changed",
        "message": (
            "Die Prüfpunkte haben sich geändert. Bitte prüfen und bestätigen "
            "Sie den aktuellen Stand erneut."
        ),
        "expected_blocker_count": 1,
        "blocker_fingerprint": _blocker_fingerprint([second]),
    }
    assert db.scalar(select(PayrollMonthPersonApproval.id)) is None


def test_archived_renamed_approval_keeps_snapshot_name_and_can_be_reopened(
    monkeypatch,
):
    db = database()
    admin, worker = payroll_users(db)
    period = PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_OPEN)
    db.add(period)
    db.flush()
    approval = PayrollMonthPersonApproval(
        year=2026,
        month=8,
        person_id=worker.id,
        status=PAYROLL_PERSON_MONTH_APPROVED,
        approval_version=1,
        ledger_reference_id=None,
        blocker_snapshot_json=[],
    )
    db.add(approval)
    db.flush()
    content = b"retained-worker-workbook"
    db.add_all(
        [
            PayrollMonthPersonApprovalArtifact(
                approval_id=approval.id,
                year=2026,
                month=8,
                person_id=worker.id,
                approval_version=1,
                ledger_reference_id="retained-without-posting",
                filename="retained-v1.xlsx",
                media_type=(
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                content=content,
                byte_size=len(content),
                content_sha256=hashlib.sha256(content).hexdigest(),
            ),
            PayrollMonthAudit(
                period_id=period.id,
                action="PERSON_MONTH_APPROVED",
                status_before="OPEN",
                status_after="APPROVED",
                details_json={
                    "person_id": worker.id,
                    "person_name": "Anna Bau (Freigabestand)",
                    "approval_version": 1,
                },
                user_id=admin.id,
            ),
        ]
    )
    db.commit()
    worker.display_name = "Anna Umbenannt"
    worker.is_active = False
    worker.person_type = PersonType.EXTERNAL
    db.commit()

    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)
    status = service.get_status(year=2026, month=8, current_user=admin)

    assert status.person_approval_summary.model_dump() == {
        "approved_count": 1,
        "total_count": 1,
    }
    assert status.person_approvals[0].person_name == "Anna Bau (Freigabestand)"
    assert status.person_approvals[0].export_ready is True
    assert status.person_approvals[0].can_reopen is True

    reopened = service.reopen_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        reason="Namensunabhängige Korrektur",
        current_user=admin,
    )
    assert reopened.person_approvals[0].person_id == worker.id
    assert reopened.person_approvals[0].status == "OPEN"


def test_internal_period_data_retains_archived_or_changed_role_but_not_external_people():
    db = database()
    admin = User(
        username="integrity-admin",
        display_name="Admin",
        password_hash="test",
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
    )
    changed_role = _person(1, "Interne Bürokraft", person_type=PersonType.INTERNAL)
    changed_role.is_active = False
    external = _person(2, "Externer Helfer", person_type=PersonType.EXTERNAL)
    db.add_all(
        [
            admin,
            changed_role,
            external,
            User(
                username="former-worker",
                display_name="Interne Bürokraft",
                password_hash="test",
                role=UserRole.OFFICE,
                is_active=True,
                must_change_password=False,
                person=changed_role,
            ),
        ]
    )
    db.flush()
    db.add_all(
        [
            _entry(changed_role.id, date(2026, 8, 5)),
            _entry(external.id, date(2026, 8, 6)),
        ]
    )
    db.commit()

    source = PayrollMonthExportService(db).load_live_source(
        year=2026,
        month=8,
        current_user=admin,
    )

    assert {person.id for person in source.people} == {changed_role.id}
    assert {entry.person_id for entry in source.entries} == {changed_role.id}


def test_status_reads_current_artifact_metadata_without_blobs_and_batches_later_approvals():
    single_count, single_sql, single_status = _status_query_sample(1)
    many_count, many_sql, many_status = _status_query_sample(20)

    assert many_count == single_count
    assert all(not item.can_reopen for item in many_status.person_approvals)
    assert all(item.export_ready for item in many_status.person_approvals)
    assert all(
        item.blocker_fingerprint == _blocker_fingerprint([])
        for item in many_status.person_approvals
    )
    for statement in single_sql + many_sql:
        normalized = " ".join(statement.lower().split())
        if not normalized.startswith("select"):
            continue
        assert "payroll_month_person_approval_artifacts.content" not in normalized
        assert "payroll_month_artifacts.content" not in normalized
    assert single_status.person_approval_summary.total_count == 1


def test_person_approval_reuses_one_transaction_source_then_loads_fresh_status(
    monkeypatch,
):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    loaded_sources = []
    readiness_sources = []
    original_load = PayrollMonthExportService.load_live_source

    def counted_load(export_service, **kwargs):
        source = original_load(export_service, **kwargs)
        loaded_sources.append(source)
        return source

    def readiness(*args):
        readiness_sources.append(args[3] if len(args) > 3 else None)
        return []

    monkeypatch.setattr(PayrollMonthExportService, "load_live_source", counted_load)
    monkeypatch.setattr(service, "_readiness_blockers", readiness)
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

    result = service.approve_person_month(
        year=2026,
        month=8,
        person_id=worker.id,
        confirmed=True,
        acknowledged_blocker_count=0,
        acknowledged_blocker_fingerprint=_blocker_fingerprint([]),
        current_user=admin,
    )

    assert len(loaded_sources) == 2
    assert readiness_sources == loaded_sources
    assert loaded_sources[0] is not loaded_sources[1]
    assert result.person_approvals[0].status == PAYROLL_PERSON_MONTH_APPROVED


def test_global_package_batches_period_artifacts_postings_and_approval_audits(
    monkeypatch,
):
    captured_names: list[list[str]] = []

    def fake_merge(workbooks):
        captured_names.append([name for name, _content in workbooks])
        return b"combined"

    monkeypatch.setattr(
        "app.services.payroll_month_close_service.merge_approved_payroll_workbooks",
        fake_merge,
    )
    single_count, single_values = _approved_package_query_sample(1)
    many_count, many_values = _approved_package_query_sample(20)

    assert many_count == single_count
    assert [item["person_name"] for item in single_values] == ["Freigabename 01"]
    assert [item["person_name"] for item in many_values] == [
        f"Freigabename {index:02d}" for index in range(1, 21)
    ]
    assert captured_names[0] == ["Freigabename 01"]
    assert captured_names[1] == [
        f"Freigabename {index:02d}" for index in range(1, 21)
    ]


def test_mutable_month_status_and_unversioned_exports_are_not_cached(monkeypatch):
    monkeypatch.setattr(
        PayrollMonthCloseService,
        "get_status",
        lambda *_args, **_kwargs: {"status": "OPEN"},
    )
    status_response = Response()
    result = payroll_months.get_payroll_month_status(
        year=2026,
        month=8,
        response=status_response,
        current_user=object(),
        db=object(),
    )
    assert result == {"status": "OPEN"}
    assert status_response.headers["Cache-Control"] == "no-store"

    monkeypatch.setattr(
        PayrollMonthExportService,
        "worker_export",
        lambda *_args, **_kwargs: b"xlsx",
    )
    unversioned = exports.payroll_monthly_worker_xlsx(
        person_id=1,
        year=2026,
        month=8,
        version=None,
        current_user=object(),
        db=object(),
    )
    versioned = exports.payroll_monthly_worker_xlsx(
        person_id=1,
        year=2026,
        month=8,
        version=1,
        current_user=object(),
        db=object(),
    )
    assert unversioned.headers["Cache-Control"] == "no-store"
    assert "Cache-Control" not in versioned.headers


def _status_query_sample(count: int):
    db = database()
    admin, _period = _approved_people(db, count=count, include_later=True)
    service = PayrollMonthCloseService(db)
    service._readiness_blockers = lambda *_args: []
    db.expire_all()
    statements: list[str] = []

    def collect(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", collect)
    try:
        status = service.get_status(year=2026, month=8, current_user=admin)
    finally:
        event.remove(engine, "before_cursor_execute", collect)
    return len(statements), statements, status


def _approved_package_query_sample(count: int):
    db = database()
    _admin, _period = _approved_people(
        db,
        count=count,
        include_later=False,
        include_postings=True,
        use_changed_names=True,
    )
    service = PayrollMonthCloseService(db)
    db.expire_all()
    statements: list[str] = []

    def collect(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", collect)
    try:
        person_values, specs, sources = service._approved_month_results(2026, 8, 1)
    finally:
        event.remove(engine, "before_cursor_execute", collect)
    assert len(specs) == count + 1
    assert len(sources) == count
    return len(statements), person_values


def _approved_people(
    db: Session,
    *,
    count: int,
    include_later: bool,
    include_postings: bool = False,
    use_changed_names: bool = False,
):
    admin = User(
        username=f"batch-admin-{count}",
        display_name="Batch Admin",
        password_hash="test",
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
    )
    period = PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_OPEN)
    db.add_all([admin, period])
    db.flush()
    for index in range(1, count + 1):
        person = _person(
            index,
            f"Aktueller Name {index:02d}" if use_changed_names else f"Person {index:02d}",
            person_type=PersonType.INTERNAL,
        )
        if use_changed_names:
            person.is_active = False
            person.person_type = PersonType.EXTERNAL
        db.add(person)
        db.flush()
        reference = f"batch-2026-08-person-{index}"
        approval = PayrollMonthPersonApproval(
            year=2026,
            month=8,
            person_id=person.id,
            status=PAYROLL_PERSON_MONTH_APPROVED,
            approval_version=1,
            ledger_reference_id=reference,
            blocker_snapshot_json=[],
        )
        db.add(approval)
        db.flush()
        content = f"worker-{index}".encode()
        db.add_all(
            [
                PayrollMonthPersonApprovalArtifact(
                    approval_id=approval.id,
                    year=2026,
                    month=8,
                    person_id=person.id,
                    approval_version=1,
                    ledger_reference_id=reference,
                    filename=f"worker-{index}.xlsx",
                    media_type=(
                        "application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet"
                    ),
                    content=content,
                    byte_size=len(content),
                    content_sha256=hashlib.sha256(content).hexdigest(),
                ),
                PayrollMonthAudit(
                    period_id=period.id,
                    action="PERSON_MONTH_APPROVED",
                    status_before="OPEN",
                    status_after="APPROVED",
                    details_json={
                        "person_id": person.id,
                        "person_name": f"Freigabename {index:02d}",
                        "approval_version": 1,
                        "source_snapshot": {"person_id": person.id},
                        "source_snapshot_sha256": hashlib.sha256(
                            f"source-{index}".encode()
                        ).hexdigest(),
                    },
                    user_id=admin.id,
                ),
            ]
        )
        if include_later:
            db.add(
                PayrollMonthPersonApproval(
                    year=2026,
                    month=9,
                    person_id=person.id,
                    status=PAYROLL_PERSON_MONTH_APPROVED,
                    approval_version=1,
                    ledger_reference_id=f"batch-2026-09-person-{index}",
                    blocker_snapshot_json=[],
                )
            )
        if include_postings:
            db.add(
                PersonHoursAccountEntry(
                    person_id=person.id,
                    entry_type="monthly_balance",
                    ledger_system="daily",
                    effective_date=date(2026, 8, 31),
                    minutes_delta=0,
                    balance_after_minutes=0,
                    note="Batch-Testbuchung",
                    source_type="payroll_month_close",
                    source_reference_id=reference,
                    idempotency_key=f"monthly:{reference}",
                    is_active=True,
                    source_payload={
                        "opening_balance_minutes": 0,
                        "movement_minutes": 0,
                        "closing_balance_minutes": 0,
                    },
                )
            )
    db.commit()
    return admin, period


def _person(person_id: int, name: str, *, person_type: PersonType) -> Person:
    return Person(
        id=person_id,
        first_name=name.split()[0],
        last_name=name.split()[-1],
        display_name=name,
        short_code=f"P{person_id}",
        person_type=person_type,
        is_active=True,
        weekly_hours=40,
    )


def _entry(person_id: int, work_date: date) -> WorkTimeEntry:
    return WorkTimeEntry(
        person_id=person_id,
        work_date=work_date,
        break_minutes=0,
        travel_minutes=0,
        work_minutes=480,
        source="manual",
        status="submitted",
        time_review_status="manually_approved",
    )
