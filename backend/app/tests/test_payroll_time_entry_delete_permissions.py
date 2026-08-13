from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import time_entries
from app.core.database import get_db
from app.models.enums import UserRole


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
    deleted_entry_ids: list[int] = []

    def __init__(self, _db) -> None:
        pass

    def delete_payroll_entry(self, entry_id: int, _current_user):
        self.deleted_entry_ids.append(entry_id)
        return SimpleNamespace(
            entry_id=entry_id,
            person_id=17,
            iso_year=2026,
            iso_week=33,
            weekly_review_reset=True,
        )


def payroll_delete_client(monkeypatch, current_user) -> TestClient:
    app = FastAPI()
    app.include_router(time_entries.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(time_entries, "TimeEntryService", FakeTimeEntryService)
    FakeTimeEntryService.deleted_entry_ids = []
    return TestClient(app)


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER])
def test_management_roles_can_delete_payroll_time_entry(monkeypatch, role: UserRole):
    response = payroll_delete_client(monkeypatch, user(role)).delete("/api/time-entries/41/payroll")

    assert response.status_code == 200
    assert response.json()["entry_id"] == 41
    assert response.json()["weekly_review_reset"] is True
    assert FakeTimeEntryService.deleted_entry_ids == [41]


def test_office_with_payroll_opt_in_can_delete_payroll_time_entry(monkeypatch):
    response = payroll_delete_client(
        monkeypatch,
        user(UserRole.OFFICE, "payroll"),
    ).delete("/api/time-entries/42/payroll")

    assert response.status_code == 200
    assert FakeTimeEntryService.deleted_entry_ids == [42]


@pytest.mark.parametrize(
    "current_user",
    [user(UserRole.OFFICE, "sites"), user(UserRole.MONTEUR)],
)
def test_unauthorized_user_cannot_delete_payroll_time_entry(monkeypatch, current_user):
    response = payroll_delete_client(monkeypatch, current_user).delete("/api/time-entries/43/payroll")

    assert response.status_code == 403
    assert FakeTimeEntryService.deleted_entry_ids == []
