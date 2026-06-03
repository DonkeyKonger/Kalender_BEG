from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes.time_entries import list_time_entries, time_entry_read
from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import GpsSourceType, UserRole
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.gps import GpsLocationPointCreate
from app.services.gps_service import GpsPresenceService


def service() -> GpsPresenceService:
    item = GpsPresenceService.__new__(GpsPresenceService)
    item.db = SimpleNamespace()
    return item


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


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


def test_point_plausibility_matches_inside_planned_site():
    point = SimpleNamespace(latitude=53.0142, longitude=9.0263)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "matched"
    assert result.planned_site_label == "8007 - Klinik"
    assert result.distance_to_planned_site_m == pytest.approx(0)


def test_point_plausibility_flags_outside_planned_site():
    point = SimpleNamespace(latitude=53.8, longitude=10.1)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "mismatch"
    assert result.distance_to_planned_site_m is not None


def test_point_plausibility_without_geofence_is_not_checkable():
    point = SimpleNamespace(latitude=53.0142, longitude=9.0263)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=None,
        longitude=None,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "not_checkable"
    assert result.distance_to_planned_site_m is None


def test_time_entry_response_uses_latest_gps_point_for_planned_site():
    db = db_session()
    work_date = date(2026, 6, 1)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    planned_site = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )
    db.add_all([person, planned_site])
    db.commit()

    db.add(Assignment(
        person_id=person.id,
        site_id=planned_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=None,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    older_outside_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.8,
        longitude=10.1,
        timestamp=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
    )
    latest_inside_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.0142,
        longitude=9.0263,
        timestamp=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
    )
    db.add_all([entry, older_outside_point, latest_inside_point])
    db.commit()

    response = time_entry_read(entry, gps_service=GpsPresenceService(db))

    assert response.gps_status == "matched"
    assert response.gps_matched_points == 1
    assert response.gps_total_points == 1
    assert response.gps_first_seen_at == older_outside_point.timestamp
    assert response.gps_last_seen_at == latest_inside_point.timestamp
    assert response.gps_work_minutes == 240


def test_review_response_adds_gps_suggestion_for_unreported_site_only():
    db = db_session()
    work_date = date(2026, 6, 2)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site_a = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=800,
    )
    site_b = Site(
        site_number="8010",
        name="Schule",
        latitude=52.2799,
        longitude=8.0472,
        geofence_radius_m=800,
    )
    db.add_all([person, site_a, site_b])
    db.commit()

    manual_entry = WorkTimeEntry(
        person_id=person.id,
        site_id=site_a.id,
        work_date=work_date,
        work_minutes=240,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    gps_points = [
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 2, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 2, 12, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.2799,
            longitude=8.0472,
            timestamp=datetime(2026, 6, 2, 13, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.2799,
            longitude=8.0472,
            timestamp=datetime(2026, 6, 2, 16, 0, tzinfo=UTC),
        ),
    ]
    db.add(manual_entry)
    db.add_all(gps_points)
    db.commit()

    response = list_time_entries(
        date_from=work_date,
        date_to=work_date,
        include_gps_status=True,
        review_open_only=True,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
        db=db,
    )

    gps_suggestions = [entry for entry in response if entry.is_gps_suggestion]
    assert len(gps_suggestions) == 1
    assert gps_suggestions[0].site_id == site_b.id
    assert gps_suggestions[0].gps_work_minutes == 180
    assert gps_suggestions[0].work_minutes == 0
    assert gps_suggestions[0].source == "gps_suggestion"
    assert not any(entry.is_gps_suggestion and entry.site_id == site_a.id for entry in response)
