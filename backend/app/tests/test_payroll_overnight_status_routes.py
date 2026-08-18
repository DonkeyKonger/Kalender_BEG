from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import time_entries
from app.core.database import get_db
from app.models.enums import OvernightStatus, UserRole


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
        person_id=None,
    )


class FakeTimeEntryService:
    saved: tuple[int, str, OvernightStatus] | None = None

    def __init__(self, _db) -> None:
        pass

    def get_overnight_status(self, *, person_id, work_date, **_kwargs):
        assert person_id == 17
        assert work_date.isoformat() == "2026-08-10"
        return OvernightStatus.SELF_PAID

    def set_payroll_overnight_status(
        self,
        *,
        person_id,
        work_date,
        overnight_status,
        **_kwargs,
    ):
        self.saved = (person_id, work_date.isoformat(), overnight_status)
        FakeTimeEntryService.saved = self.saved
        return overnight_status


def overnight_status_client(monkeypatch, current_user) -> TestClient:
    app = FastAPI()
    app.include_router(time_entries.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(time_entries, "TimeEntryService", FakeTimeEntryService)
    FakeTimeEntryService.saved = None
    return TestClient(app)


def test_day_status_get_keeps_returning_the_canonical_daily_status(monkeypatch):
    response = overnight_status_client(monkeypatch, user(UserRole.ADMIN)).get(
        "/api/time-entries/day-status?person_id=17&work_date=2026-08-10"
    )

    assert response.status_code == 200
    assert response.json() == {
        "person_id": 17,
        "work_date": "2026-08-10",
        "overnight_status": "self_paid",
    }


def test_payroll_editor_updates_status_by_person_and_work_date(monkeypatch):
    response = overnight_status_client(monkeypatch, user(UserRole.OFFICE, "payroll")).patch(
        "/api/time-entries/day-status?person_id=17&work_date=2026-08-10",
        json={"overnight_status": "beg_paid"},
    )

    assert response.status_code == 200
    assert response.json()["overnight_status"] == "beg_paid"
    assert FakeTimeEntryService.saved == (17, "2026-08-10", OvernightStatus.BEG_PAID)


def test_payroll_editor_rejects_users_without_payroll_permission(monkeypatch):
    response = overnight_status_client(monkeypatch, user(UserRole.OFFICE, "sites")).patch(
        "/api/time-entries/day-status?person_id=17&work_date=2026-08-10",
        json={"overnight_status": "none"},
    )

    assert response.status_code == 403
    assert FakeTimeEntryService.saved is None
