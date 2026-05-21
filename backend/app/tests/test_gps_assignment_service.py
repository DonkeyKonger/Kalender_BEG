from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

from app.services.gps_assignment_service import (
    GpsTrackPoint,
    detect_vehicle_person_assignment,
)


def point(minutes: int, lat: float = 53.0142, lon: float = 9.0263) -> datetime:
    return datetime(2026, 5, 21, 7, 0, tzinfo=UTC) + timedelta(minutes=minutes)


def track(person_id: int | None = 1, vehicle_id: int | None = None, lon: float = 9.0263):
    return [
        GpsTrackPoint(53.0142, lon, point(0), person_id=person_id, vehicle_id=vehicle_id),
        GpsTrackPoint(53.0144, lon, point(390), person_id=person_id, vehicle_id=vehicle_id),
    ]


def site():
    return SimpleNamespace(id=10, latitude=53.0142, longitude=9.0263, geofence_radius_m=5000)


def test_detect_vehicle_person_assignment_matches_single_person_over_6h_near_vehicle():
    result = detect_vehicle_person_assignment(
        person_gps_points=track(person_id=7),
        vehicle_gps_points=track(person_id=None, vehicle_id=3),
        site=site(),
        day=date(2026, 5, 21),
        team_context=[7],
    )

    assert result.matched is True
    assert result.confidence == "high"
    assert result.duration_minutes == 390
    assert result.reason == "person_and_vehicle_on_site_over_6h_within_2km"


def test_detect_vehicle_person_assignment_rejects_multiple_person_context():
    result = detect_vehicle_person_assignment(
        person_gps_points=track(person_id=7),
        vehicle_gps_points=track(person_id=None, vehicle_id=3),
        site=site(),
        day=date(2026, 5, 21),
        team_context=[7, 8],
    )

    assert result.matched is False
    assert result.reason == "not_unique_person_context"


def test_detect_vehicle_person_assignment_rejects_short_presence():
    person_points = [
        GpsTrackPoint(53.0142, 9.0263, point(0), person_id=7),
        GpsTrackPoint(53.0144, 9.0263, point(120), person_id=7),
    ]
    vehicle_points = [
        GpsTrackPoint(53.0142, 9.0263, point(0), vehicle_id=3),
        GpsTrackPoint(53.0144, 9.0263, point(120), vehicle_id=3),
    ]

    result = detect_vehicle_person_assignment(
        person_points, vehicle_points, site(), date(2026, 5, 21), team_context=[7]
    )

    assert result.matched is False
    assert result.reason == "presence_under_6h"


def test_detect_vehicle_person_assignment_rejects_person_far_from_vehicle():
    result = detect_vehicle_person_assignment(
        person_gps_points=track(person_id=7, lon=9.0263),
        vehicle_gps_points=track(person_id=None, vehicle_id=3, lon=9.0650),
        site=site(),
        day=date(2026, 5, 21),
        team_context=[7],
    )

    assert result.matched is False
    assert result.reason == "person_vehicle_distance_over_2km"
