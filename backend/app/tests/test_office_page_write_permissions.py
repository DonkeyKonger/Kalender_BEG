from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import (
    absences,
    admin_ctrack,
    assignments,
    customers,
    dashboard,
    exports,
    matrix,
    persons,
    sites,
    time_entries,
    tool_material_items,
    users,
)
from app.core.database import get_db
from app.models.enums import AbsenceStatus, UserRole


WRITE_POLICIES = [
    (assignments.CAN_WRITE, "calendar"),
    (matrix.CAN_WRITE, "calendar"),
    (absences.CAN_WRITE, "absences"),
    (absences.CAN_WRITE, "calendar"),
    (customers.CAN_WRITE, "customers"),
    (customers.CAN_CREATE, "sites"),
    (persons.CAN_WRITE, "employees"),
    (persons.CAN_EXTERNAL_WRITE, "calendar"),
    (sites.CAN_WRITE, "sites"),
    (sites.CAN_WRITE, "calendar"),
    (time_entries.CAN_REVIEW, "payroll"),
]

CROSS_PAGE_READ_POLICIES = [
    (dashboard.CAN_READ_DASHBOARD, "overview"),
    (dashboard.CAN_READ_DASHBOARD_NOTES, "calendar"),
    (absences.CAN_READ, "calendar"),
    (absences.CAN_READ, "payroll"),
    (customers.CAN_READ, "sites"),
    (customers.CAN_READ, "calendar"),
    (sites.CAN_READ, "customers"),
    (sites.CAN_READ, "payroll"),
    (time_entries.CAN_ACCESS, "sites"),
    (exports.CAN_EXPORT, "export"),
    (exports.CAN_PAYROLL_EXPORT, "payroll"),
    (admin_ctrack.CAN_READ_VEHICLE_POSITIONS, "map"),
    (persons.CAN_LIST, "miscellaneous"),
]


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
        person_id=None,
    )


def policy_status(policy, current_user) -> int:
    app = FastAPI()

    @app.get("/check")
    def check_policy(_user=Depends(policy)):
        return {"allowed": True}

    app.dependency_overrides[get_current_user] = lambda: current_user
    return TestClient(app).get("/check").status_code


@pytest.mark.parametrize(("policy", "permission"), WRITE_POLICIES)
def test_office_page_opt_in_grants_normal_write_policy(policy, permission: str):
    assert policy_status(policy, user(UserRole.OFFICE, permission)) == 200


@pytest.mark.parametrize(("policy", "_permission"), WRITE_POLICIES)
def test_office_without_matching_opt_in_is_denied_write_policy(policy, _permission: str):
    assert policy_status(policy, user(UserRole.OFFICE, "overview")) == 403


@pytest.mark.parametrize(("policy", "permission"), CROSS_PAGE_READ_POLICIES)
def test_nested_page_data_uses_the_parent_page_opt_in(policy, permission: str):
    assert policy_status(policy, user(UserRole.OFFICE, permission)) == 200


@pytest.mark.parametrize(("policy", "_permission"), WRITE_POLICIES)
@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER])
def test_existing_management_roles_keep_write_access(policy, _permission: str, role: UserRole):
    assert policy_status(policy, user(role)) == 200


@pytest.mark.parametrize(("policy", "_permission"), WRITE_POLICIES)
def test_monteur_does_not_gain_business_page_write_access(policy, _permission: str):
    assert policy_status(policy, user(UserRole.MONTEUR)) == 403


def test_payroll_opt_in_does_not_grant_the_separate_general_export_page():
    assert policy_status(
        exports.CAN_EXPORT,
        user(UserRole.OFFICE, "payroll"),
    ) == 403


def test_miscellaneous_policy_allows_admin_and_opted_in_office_only():
    assert policy_status(tool_material_items.CAN_MANAGE, user(UserRole.ADMIN)) == 200
    assert policy_status(
        tool_material_items.CAN_MANAGE,
        user(UserRole.OFFICE, "miscellaneous"),
    ) == 200
    assert policy_status(tool_material_items.CAN_MANAGE, user(UserRole.OFFICE)) == 403
    assert policy_status(
        tool_material_items.CAN_MANAGE,
        user(UserRole.PROJECT_MANAGER, "miscellaneous"),
    ) == 403
    assert policy_status(tool_material_items.CAN_MANAGE, user(UserRole.MONTEUR)) == 403


class FakeAbsenceService:
    def __init__(self, _db) -> None:
        pass

    def create_absence(self, payload, _user_id: int):
        return absence_record(payload)

    def update_absence(self, _absence_id: int, payload, _user_id: int):
        return absence_record(payload)

    def delete_absence(self, _absence_id: int, _user_id: int) -> None:
        pass

    def set_vacation_carryover(
        self,
        *,
        person_id: int,
        year: int,
        carryover_days: int,
        user_id: int,
    ):
        return SimpleNamespace(
            person_id=person_id,
            year=year,
            carryover_days=carryover_days,
            updated_by_user_id=user_id,
        )


def absence_record(payload):
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=11,
        person_id=payload.person_id or 3,
        absence_type=payload.absence_type or "vacation",
        start_date=payload.start_date or datetime(2026, 7, 20).date(),
        end_date=payload.end_date or datetime(2026, 7, 21).date(),
        status=payload.status or AbsenceStatus.ACTIVE,
        note=payload.note,
        created_by_user_id=7,
        updated_by_user_id=7,
        created_at=now,
        updated_at=now,
    )


def office_api_client(monkeypatch, current_user) -> TestClient:
    app = FastAPI()
    app.include_router(absences.router, prefix="/api")
    app.include_router(users.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(absences, "AbsenceService", FakeAbsenceService)
    return TestClient(app)


ABSENCE_CREATE_PAYLOAD = {
    "person_id": 3,
    "absence_type": "vacation",
    "start_date": "2026-07-20",
    "end_date": "2026-07-21",
    "status": "active",
    "note": "Urlaub",
}


def test_office_with_opt_in_can_use_post_patch_put_and_delete(monkeypatch):
    client = office_api_client(
        monkeypatch,
        user(UserRole.OFFICE, "absences", "employees"),
    )

    assert client.post("/api/absences", json=ABSENCE_CREATE_PAYLOAD).status_code == 201
    assert client.patch("/api/absences/11", json={"note": "Geändert"}).status_code == 200
    assert client.put(
        "/api/absences/vacation-carryover",
        json={"person_id": 3, "year": 2026, "carryover_days": 4},
    ).status_code == 200
    assert client.delete("/api/absences/11").status_code == 204


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/api/absences", ABSENCE_CREATE_PAYLOAD),
        ("patch", "/api/absences/11", {"note": "Geändert"}),
        (
            "put",
            "/api/absences/vacation-carryover",
            {"person_id": 3, "year": 2026, "carryover_days": 4},
        ),
        ("delete", "/api/absences/11", None),
    ],
)
def test_office_without_opt_in_is_denied_actual_write_endpoints(
    monkeypatch,
    method: str,
    path: str,
    payload,
):
    client = office_api_client(monkeypatch, user(UserRole.OFFICE))

    response = client.request(method, path, json=payload)

    assert response.status_code == 403


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER])
def test_existing_management_roles_can_use_actual_write_endpoint(monkeypatch, role: UserRole):
    client = office_api_client(monkeypatch, user(role))

    assert client.post("/api/absences", json=ABSENCE_CREATE_PAYLOAD).status_code == 201


def test_monteur_cannot_use_actual_business_write_endpoint(monkeypatch):
    client = office_api_client(monkeypatch, user(UserRole.MONTEUR))

    assert client.post("/api/absences", json=ABSENCE_CREATE_PAYLOAD).status_code == 403


def test_office_opt_ins_do_not_grant_admin_user_management(monkeypatch):
    client = office_api_client(
        monkeypatch,
        user(
            UserRole.OFFICE,
            "overview",
            "calendar",
            "absences",
            "sites",
            "map",
            "payroll",
            "customers",
            "employees",
            "export",
        ),
    )

    assert client.get("/api/users").status_code == 403
