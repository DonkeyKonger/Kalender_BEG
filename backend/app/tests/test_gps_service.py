from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.enums import UserRole
from app.schemas.gps import GpsLocationPointCreate
from app.services.gps_service import GpsPresenceService


def service() -> GpsPresenceService:
    item = GpsPresenceService.__new__(GpsPresenceService)
    item.db = SimpleNamespace()
    return item


def test_monteur_cannot_send_gps_point_for_other_person():
    current_user = SimpleNamespace(role=UserRole.MONTEUR, person_id=5)

    with pytest.raises(HTTPException) as error:
        service()._effective_person_id(current_user, 6)

    assert error.value.status_code == 403


def test_admin_can_send_test_gps_point_for_person():
    current_user = SimpleNamespace(role=UserRole.ADMIN, person_id=None)

    assert service()._effective_person_id(current_user, 6) == 6


def test_gps_point_rejects_invalid_coordinates():
    with pytest.raises(ValidationError):
        GpsLocationPointCreate(
            person_id=1,
            captured_at=datetime.now(UTC),
            latitude=120,
            longitude=9.0263,
        )


def test_presence_status_for_missing_points():
    assert service()._presence_status(total_points=0, matched_points=0) == "missing"


def test_presence_status_for_all_points_inside_radius():
    assert service()._presence_status(total_points=1, matched_points=1) == "matched"


def test_presence_status_for_mixed_points():
    assert service()._presence_status(total_points=3, matched_points=1) == "partial"


def test_presence_status_for_points_outside_radius():
    assert service()._presence_status(total_points=3, matched_points=0) == "mismatch"
