import hashlib
from datetime import date
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.enums import UserRole
from app.models.payroll_month import (
    PayrollMonthPeriod, PayrollMonthSnapshot, PayrollMonthAudit,
    PayrollMonthPersonApproval, PayrollMonthPersonApprovalArtifact,
)
from app.models.person_hours_account import PersonHoursAccountEntry
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.tests.test_payroll_month_export_service import database, person, entry


@pytest.fixture
def approved_workers(monkeypatch):
    db = database()
    people = [person(1, "Anna", "Bau"), person(2, "Bernd", "Strom")]
    for worker in people:
        worker.weekly_hours = 40
    db.add_all(people)
    db.add_all([entry(1, 1, None, date(2026, 8, 3)), entry(2, 2, None, date(2026, 8, 4))])
    db.commit()
    service = PayrollMonthExportService(db)
    admin = SimpleNamespace(role=UserRole.ADMIN, person_id=None)
    approvals, artifacts, workbooks = [], [], []
    for worker in people:
        content = service.build_worker_export_from_live_data(
            person_id=worker.id, year=2026, month=8, current_user=admin,
            opening_balance_minutes=100, closing_balance_minutes=250,
        )
        approval = PayrollMonthPersonApproval(
            year=2026, month=8, person_id=worker.id, status="APPROVED",
            approval_version=1, ledger_reference_id=f"approved:{worker.id}",
            blocker_snapshot_json=[],
        )
        db.add(approval)
        db.flush()
        artifact = PayrollMonthPersonApprovalArtifact(
            approval_id=approval.id, year=2026, month=8, person_id=worker.id,
            approval_version=1, ledger_reference_id=approval.ledger_reference_id,
            filename=f"worker-{worker.id}.xlsx",
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content=content, byte_size=len(content), content_sha256=hashlib.sha256(content).hexdigest(),
        )
        db.add(artifact)
        approvals.append(approval)
        artifacts.append(artifact)
        workbooks.append(content)
    db.commit()

    def no_live_rebuild(*_args, **_kwargs):
        raise AssertionError("Combined download must only package retained individual workbooks")

    monkeypatch.setattr(service, "load_live_source", no_live_rebuild)
    monkeypatch.setattr(service, "build_all_workers_export_from_source", no_live_rebuild)
    yield SimpleNamespace(
        db=db, service=service, approvals=approvals, artifacts=artifacts,
        workbooks=workbooks, args=dict(year=2026, month=8, current_user=admin),
    )
    db.close()


def test_all_individual_approvals_enable_combined_download_without_global_close(approved_workers):
    case = approved_workers
    combined = case.service.all_workers_export(**case.args)
    with ZipFile(BytesIO(combined)) as merged:
        for index, content in enumerate(case.workbooks, 1):
            with ZipFile(BytesIO(content)) as single:
                assert merged.read(f"xl/worksheets/sheet{index}.xml") == single.read("xl/worksheets/sheet1.xml")
    assert case.service.all_workers_export(**case.args)  # repeat: no account/global side effect
    for model in (PayrollMonthPeriod, PayrollMonthSnapshot, PayrollMonthAudit, PersonHoursAccountEntry):
        assert list(case.db.scalars(select(model))) == []
    assert [(item.status, item.approval_version) for item in case.approvals] == [("APPROVED", 1)] * 2
    assert [item.content for item in case.artifacts] == case.workbooks
    assert not case.db.new and not case.db.dirty and not case.db.deleted


@pytest.mark.parametrize("state, code", [
    ("open", "payroll_person_month_not_approved"),
    ("missing_approval", "payroll_person_month_not_approved"),
    ("missing_artifact", "payroll_person_month_snapshot_missing"),
    ("stale_artifact", "payroll_person_month_snapshot_missing"),
    ("corrupt", "payroll_person_month_artifact_corrupt"),
    ("incompatible", "payroll_approved_workbooks_incompatible"),
])
def test_incomplete_or_invalid_individual_approvals_never_fall_back_to_live_data(approved_workers, state, code):
    case = approved_workers
    if state == "open":
        case.approvals[1].status = "OPEN"  # retained historical artifact must not be reused
    elif state == "missing_approval":
        case.db.delete(case.approvals[1])
    elif state == "missing_artifact":
        case.db.delete(case.artifacts[1])
    elif state == "stale_artifact":
        case.approvals[1].approval_version = 2
    elif state == "corrupt":
        case.artifacts[1].content = b"broken"
    elif state == "incompatible":
        case.artifacts[1].content = b"not an Excel file"
        case.artifacts[1].byte_size = len(case.artifacts[1].content)
        case.artifacts[1].content_sha256 = hashlib.sha256(case.artifacts[1].content).hexdigest()
    case.db.commit()
    with pytest.raises(HTTPException) as caught:
        case.service.all_workers_export(**case.args)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == code
    assert list(case.db.scalars(select(PersonHoursAccountEntry))) == []


def test_historical_snapshot_and_version_requests_do_not_switch_to_individual_export(approved_workers, monkeypatch):
    case = approved_workers
    calls = []

    def locked_artifact(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(content=b"unchanged historical snapshot")

    monkeypatch.setattr(case.service, "_locked_artifact", locked_artifact)
    case.db.add(PayrollMonthPeriod(year=2026, month=8, status="LOCKED", last_snapshot_version=2))
    case.db.commit()
    assert case.service.all_workers_export(**case.args) == b"unchanged historical snapshot"
    assert case.service.all_workers_export(**case.args, version=2) == b"unchanged historical snapshot"
    assert [item["version"] for item in calls] == [None, 2]
    period = case.db.scalar(select(PayrollMonthPeriod))
    period.status = "OPEN"
    case.db.commit()
    case.service.all_workers_export(**case.args, version=2)
    assert calls[-1]["version"] == 2  # normal _locked_artifact rejects a reopened snapshot
