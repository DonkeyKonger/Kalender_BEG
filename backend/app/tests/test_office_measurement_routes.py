from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import MeasurementBatchOrigin, UserRole
from app.schemas.measurement import (
    MobileMeasurementBatchAvailableActionsRead,
    MobileMeasurementBatchBlockReasonsRead,
    MobileMeasurementBatchRead,
)


def current_user(role: UserRole, *permissions: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=7,
        role=role,
        person_id=None,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def created_batch() -> MobileMeasurementBatchRead:
    now = datetime.now(timezone.utc)
    return MobileMeasurementBatchRead(
        id=12,
        site_id=8,
        measurement_base_id=4,
        measurement_base_name="Hauptangebot",
        offer_id=4,
        offer_name="Hauptangebot",
        is_current_offer=True,
        number=2,
        title="Aufmaß 2",
        status="draft",
        origin=MeasurementBatchOrigin.OFFICE,
        creator_role_at_creation=UserRole.OFFICE.value,
        area_location="1. Obergeschoss",
        measurement_date=date(2026, 7, 16),
        assigned_employee_id=None,
        assigned_employee_name=None,
        has_original_worker_submission=False,
        created_by_user_id=7,
        submitted_by_user_id=None,
        submitted_by_name=None,
        submitted_at=None,
        customer_signed_at=None,
        customer_signature_name=None,
        customer_signature_place=None,
        worker_signed_at=None,
        worker_signature_name=None,
        created_at=now,
        updated_at=now,
        position_count=0,
        entry_count=0,
        reported_minutes=None,
        reported_hours=None,
        available_actions=MobileMeasurementBatchAvailableActionsRead(can_customer_sign=False),
        block_reasons=MobileMeasurementBatchBlockReasonsRead(),
    )


class FakeMeasurementService:
    def __init__(self, _db) -> None:
        pass

    def create_office_batch(self, *, site_id, current_user, payload):
        assert site_id == 8
        assert current_user.id == 7
        assert payload.area_location == "1. Obergeschoss"
        return created_batch()


def api_client(monkeypatch, user) -> TestClient:
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(sites, "MeasurementService", FakeMeasurementService)
    return TestClient(app)


PAYLOAD = {
    "area_location": "1. Obergeschoss",
    "measurement_date": "2026-07-16",
    "assigned_employee_id": None,
    "offer_id": 4,
    "request_id": "route-measurement-request",
}


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER])
def test_management_roles_can_create_office_measurement(monkeypatch, role: UserRole):
    response = api_client(monkeypatch, current_user(role)).post(
        "/api/sites/8/measurement-batches",
        json=PAYLOAD,
    )

    assert response.status_code == 201
    assert response.json()["origin"] == "OFFICE"


def test_office_with_sites_opt_in_can_create_office_measurement(monkeypatch):
    response = api_client(monkeypatch, current_user(UserRole.OFFICE, "sites")).post(
        "/api/sites/8/measurement-batches",
        json=PAYLOAD,
    )

    assert response.status_code == 201


@pytest.mark.parametrize(
    "user",
    [current_user(UserRole.OFFICE), current_user(UserRole.MONTEUR)],
)
def test_unauthorized_roles_cannot_create_office_measurement(monkeypatch, user):
    response = api_client(monkeypatch, user).post(
        "/api/sites/8/measurement-batches",
        json=PAYLOAD,
    )

    assert response.status_code == 403
