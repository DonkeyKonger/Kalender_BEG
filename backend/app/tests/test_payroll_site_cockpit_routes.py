from datetime import date
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import time_entries
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.payroll_site_cockpit import (
    PayrollSiteCockpitHistoryPointRead,
    PayrollSiteCockpitHistoryRead,
    PayrollSiteCockpitRead,
    PayrollSiteCockpitTotalsRead,
)
from app.services.payroll_site_cockpit_service import FORECAST_UNAVAILABLE_REASON
from app.services.payroll_site_cockpit_service import OFFER_BUDGET_BASIS


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def api_client(monkeypatch, *, current_user, calls: list[tuple]) -> TestClient:
    class FakePayrollSiteCockpitService:
        def __init__(self, db):
            calls.append(("init", db))

        def get_cockpit(self, *, date_from: date, date_to: date):
            calls.append(("cockpit", date_from, date_to))
            return PayrollSiteCockpitRead(
                date_from=date_from,
                date_to=date_to,
                effective_as_of=date_to,
                offer_budget_basis=OFFER_BUDGET_BASIS,
                offer_budget_as_of=date(2026, 8, 30),
                totals=PayrollSiteCockpitTotalsRead(
                    offer_minutes=600,
                    actual_minutes=420,
                    forecast_minutes=None,
                    forecast_reason=FORECAST_UNAVAILABLE_REASON,
                    variance_minutes=None,
                    site_count=1,
                    budget_site_count=1,
                    forecast_site_count=0,
                ),
            )

        def get_history(self, *, site_id: int, date_to: date):
            calls.append(("history", site_id, date_to))
            return PayrollSiteCockpitHistoryRead(
                site_id=site_id,
                site_number="1001",
                site_name="Baustelle",
                date_from=date(2026, 8, 1),
                date_to=date_to,
                effective_as_of=date_to,
                offer_budget_basis=OFFER_BUDGET_BASIS,
                offer_budget_as_of=date(2026, 8, 30),
                offer_minutes=600,
                forecast_minutes=None,
                forecast_reason=FORECAST_UNAVAILABLE_REASON,
                points=[
                    PayrollSiteCockpitHistoryPointRead(
                        date=date(2026, 8, 1),
                        actual_minutes=420,
                        forecast_minutes=None,
                    )
                ],
            )

    monkeypatch.setattr(
        time_entries,
        "PayrollSiteCockpitService",
        FakePayrollSiteCockpitService,
    )
    app = FastAPI()
    app.include_router(time_entries.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: "database"
    return TestClient(app)


def test_cockpit_route_has_expected_shape_and_disables_caching(monkeypatch) -> None:
    calls: list[tuple] = []
    client = api_client(
        monkeypatch,
        current_user=user(UserRole.OFFICE, "payroll"),
        calls=calls,
    )

    response = client.get(
        "/api/time-entries/payroll-site-cockpit",
        params={"date_from": "2026-08-01", "date_to": "2026-08-31"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "date_from": "2026-08-01",
        "date_to": "2026-08-31",
        "effective_as_of": "2026-08-31",
        "offer_budget_basis": OFFER_BUDGET_BASIS,
        "offer_budget_as_of": "2026-08-30",
        "totals": {
            "offer_minutes": 600.0,
            "actual_minutes": 420,
            "forecast_minutes": None,
            "forecast_reason": FORECAST_UNAVAILABLE_REASON,
            "variance_minutes": None,
            "site_count": 1,
            "budget_site_count": 1,
            "forecast_site_count": 0,
        },
        "sites": [],
        "action_items": [],
    }
    assert ("cockpit", date(2026, 8, 1), date(2026, 8, 31)) in calls


def test_history_route_has_expected_shape_and_disables_caching(monkeypatch) -> None:
    calls: list[tuple] = []
    client = api_client(
        monkeypatch,
        current_user=user(UserRole.PROJECT_MANAGER),
        calls=calls,
    )

    response = client.get(
        "/api/time-entries/payroll-site-cockpit/11/history",
        params={"date_to": "2026-08-31"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["site_id"] == 11
    assert response.json()["effective_as_of"] == "2026-08-31"
    assert response.json()["offer_budget_basis"] == OFFER_BUDGET_BASIS
    assert response.json()["offer_budget_as_of"] == "2026-08-30"
    assert response.json()["forecast_reason"] == FORECAST_UNAVAILABLE_REASON
    assert response.json()["points"] == [
        {
            "date": "2026-08-01",
            "actual_minutes": 420,
            "forecast_minutes": None,
        }
    ]
    assert ("history", 11, date(2026, 8, 31)) in calls


def test_cockpit_routes_require_payroll_access_for_office_users(monkeypatch) -> None:
    calls: list[tuple] = []
    client = api_client(
        monkeypatch,
        current_user=user(UserRole.OFFICE),
        calls=calls,
    )

    cockpit_response = client.get(
        "/api/time-entries/payroll-site-cockpit",
        params={"date_from": "2026-08-01", "date_to": "2026-08-31"},
    )
    history_response = client.get(
        "/api/time-entries/payroll-site-cockpit/11/history",
        params={"date_to": "2026-08-31"},
    )

    assert cockpit_response.status_code == 403
    assert history_response.status_code == 403
    assert calls == []


def test_cockpit_route_rejects_ranges_spanning_calendar_months() -> None:
    app = FastAPI()
    app.include_router(time_entries.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: user(UserRole.ADMIN)
    app.dependency_overrides[get_db] = lambda: object()

    response = TestClient(app).get(
        "/api/time-entries/payroll-site-cockpit",
        params={"date_from": "2026-08-31", "date_to": "2026-09-01"},
    )

    assert response.status_code == 400
    assert "selben Kalendermonat" in response.json()["detail"]
