from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.api.routes import payroll_months
from app.core.database import get_db
from app.models import Base
from app.models.enums import UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApproval
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.payroll_daily_ledger_service import PayrollDailyLedgerService
from app.services.gps_service import GpsPresenceService


@pytest.fixture
def harness(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    app = FastAPI()
    app.include_router(payroll_months.router, prefix="/api")
    current_user = SimpleNamespace(id=1, role=UserRole.ADMIN, is_active=True,
                                   must_change_password=False, office_page_permissions=[])
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: db

    def forbidden(*args, **kwargs):
        raise AssertionError("Lock status must not calculate readiness or load artifacts")

    for method in ("get_status", "_readiness_blockers", "_domain_blockers", "_ledger_service",
                   "_current_snapshot", "_payroll_people", "_person_approvals", "_artifacts_ready"):
        monkeypatch.setattr(PayrollMonthCloseService, method, forbidden)
    monkeypatch.setattr(PayrollMonthExportService, "load_live_source", forbidden)
    monkeypatch.setattr(PayrollDailyLedgerService, "validate_month_readiness", forbidden)
    monkeypatch.setattr(GpsPresenceService, "evaluate_time_entries", forbidden)
    monkeypatch.setattr(GpsPresenceService, "list_site_stays_for_review", forbidden)
    statements = []
    commits = []
    event.listen(engine, "before_cursor_execute", lambda *args: statements.append(args[2]))
    event.listen(db, "after_commit", lambda session: commits.append(True))
    with TestClient(app) as client:
        yield SimpleNamespace(db=db, app=app, client=client, user=current_user,
                              statements=statements, commits=commits)
    db.close()
    engine.dispose()


def seed(h, *, global_status=None):
    if global_status:
        h.db.add(PayrollMonthPeriod(year=2026, month=8, status=global_status))
    # Isolated SQLite IDs: no production people or data are loaded.
    h.db.add_all([
        PayrollMonthPersonApproval(year=2026, month=8, person_id=9, status="APPROVED"),
        PayrollMonthPersonApproval(year=2026, month=8, person_id=3, status="APPROVED"),
        PayrollMonthPersonApproval(year=2026, month=8, person_id=4, status="OPEN"),
        PayrollMonthPersonApproval(year=2026, month=9, person_id=8, status="APPROVED"),
    ])
    h.db.commit()
    h.statements.clear()
    h.commits.clear()


@pytest.mark.parametrize("global_status", [None, "OPEN", "LOCKED"])
def test_lock_read_uses_two_selects_and_no_full_validation_or_writes(harness, global_status):
    h = harness
    seed(h, global_status=global_status)
    response = h.client.get("/api/payroll-months/2026/8/lock-status")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "year": 2026, "month": 8, "status": global_status or "OPEN",
        "approved_person_ids": [3, 9],
    }
    assert len(h.statements) == 2
    assert all(statement.lstrip().startswith("SELECT") for statement in h.statements)
    assert all("JOIN" not in statement and "content" not in statement for statement in h.statements)
    assert h.commits == []


def test_kw36_reads_only_four_status_selects_without_monthly_work(harness):
    h = harness
    seed(h, global_status="OPEN")
    periods = [h.client.get(f"/api/payroll-months/2026/{month}/lock-status").json() for month in (8, 9)]
    assert [period["approved_person_ids"] for period in periods] == [[3, 9], [8]]
    assert len(h.statements) == 4
    assert all(statement.lstrip().startswith("SELECT") for statement in h.statements)
    assert h.commits == []


def test_reopen_and_new_approval_are_visible_on_next_read_without_cache(harness):
    h = harness
    seed(h, global_status="LOCKED")
    assert h.client.get("/api/payroll-months/2026/8/lock-status").json()["status"] == "LOCKED"
    period = h.db.query(PayrollMonthPeriod).one()
    period.status = "OPEN"
    approval = h.db.query(PayrollMonthPersonApproval).filter_by(person_id=9).one()
    approval.status = "OPEN"
    h.db.commit()
    response = h.client.get("/api/payroll-months/2026/8/lock-status").json()
    assert response["status"] == "OPEN"
    assert response["approved_person_ids"] == [3]
    approval.status = "APPROVED"
    h.db.commit()
    assert h.client.get("/api/payroll-months/2026/8/lock-status").json()["approved_person_ids"] == [3, 9]


def test_year_boundary_does_not_mix_person_approvals(harness):
    h = harness
    h.db.add(PayrollMonthPersonApproval(year=2026, month=12, person_id=3, status="APPROVED"))
    h.db.commit()
    assert h.client.get("/api/payroll-months/2026/12/lock-status").json()["approved_person_ids"] == [3]
    assert h.client.get("/api/payroll-months/2027/1/lock-status").json()["approved_person_ids"] == []


@pytest.mark.parametrize("year,month", [(1999, 8), (2101, 8), (2026, 0), (2026, 13)])
def test_invalid_month_is_rejected_before_database_access(harness, year, month):
    response = harness.client.get(f"/api/payroll-months/{year}/{month}/lock-status")
    assert response.status_code == 400
    assert harness.statements == []


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["payroll"], 200), (UserRole.OFFICE, [], 403),
    (UserRole.MONTEUR, [], 403),
])
def test_same_payroll_permissions_as_full_status(harness, role, permissions, expected):
    harness.user.role = role
    harness.user.office_page_permissions = permissions
    response = harness.client.get("/api/payroll-months/2026/8/lock-status")
    assert response.status_code == expected
    if expected == 403:
        assert harness.statements == []


def test_unauthenticated_request_is_rejected(harness):
    del harness.app.dependency_overrides[get_current_user]
    assert harness.client.get("/api/payroll-months/2026/8/lock-status").status_code == 401
    assert harness.statements == []


def test_database_failure_is_not_reported_as_an_open_month(harness, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("database unavailable")
    monkeypatch.setattr(harness.db, "scalar", fail)
    with TestClient(harness.app, raise_server_exceptions=False) as client:
        assert client.get("/api/payroll-months/2026/8/lock-status").status_code == 500
