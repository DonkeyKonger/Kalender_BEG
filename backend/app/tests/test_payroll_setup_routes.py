from datetime import date
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.dependencies import get_current_user
from app.api.routes import payroll_setup
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.payroll_setup import PayrollSetupRead


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
        person_id=None,
    )


class FakeDb:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakePayrollDailyLedgerService:
    weekly_payload = None
    opening_payload = None

    def __init__(self, _db) -> None:
        pass

    def setup_status(self, *, effective_date: date) -> PayrollSetupRead:
        return PayrollSetupRead(
            effective_date=effective_date,
            is_ready=True,
            workers=[],
        )

    def upsert_weekly_schedule(self, *, person_id, payload, current_user):
        self.__class__.weekly_payload = (person_id, payload, current_user.id)

    def upsert_opening_balance(self, *, person_id, payload, current_user):
        self.__class__.opening_payload = (person_id, payload, current_user.id)


def client(monkeypatch, current_user) -> tuple[TestClient, FakeDb]:
    app = FastAPI()
    app.include_router(payroll_setup.router, prefix="/api")
    db = FakeDb()
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: db
    monkeypatch.setattr(
        payroll_setup,
        "PayrollDailyLedgerService",
        FakePayrollDailyLedgerService,
    )
    return TestClient(app), db


@pytest.mark.parametrize(
    ("current_user", "expected"),
    [
        (user(UserRole.ADMIN), 200),
        (user(UserRole.OFFICE, "payroll"), 200),
        (user(UserRole.OFFICE), 403),
        (user(UserRole.PROJECT_MANAGER, "payroll"), 403),
        (user(UserRole.MONTEUR), 403),
    ],
)
def test_payroll_setup_is_restricted_to_admin_and_payroll_office(
    monkeypatch, current_user, expected
):
    api, _db = client(monkeypatch, current_user)

    response = api.get("/api/payroll-setup?effective_date=2026-08-01")

    assert response.status_code == expected


def test_confirm_setup_routes_return_complete_refreshed_setup(monkeypatch):
    api, db = client(monkeypatch, user(UserRole.OFFICE, "payroll"))

    plan_response = api.put(
        "/api/payroll-setup/workers/42/weekly-plan",
        json={
            "valid_from": "2026-08-01",
            "weekday_minutes": [480, 480, 480, 480, 480, 0, 0],
            "confirm": True,
        },
    )
    balance_response = api.put(
        "/api/payroll-setup/workers/42/opening-balance",
        json={
            "effective_date": "2026-07-31",
            "minutes": -90,
            "confirm": True,
        },
    )

    assert plan_response.status_code == balance_response.status_code == 200
    assert plan_response.json() == {
        "effective_date": "2026-08-01",
        "is_ready": True,
        "workers": [],
    }
    assert balance_response.json() == plan_response.json()
    assert FakePayrollDailyLedgerService.weekly_payload[0] == 42
    assert FakePayrollDailyLedgerService.weekly_payload[1].weekday_minutes == [
        480,
        480,
        480,
        480,
        480,
        0,
        0,
    ]
    assert FakePayrollDailyLedgerService.opening_payload[1].minutes == -90
    assert db.commits == 2
