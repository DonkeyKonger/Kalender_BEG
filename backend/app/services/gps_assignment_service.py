from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.services.geo_service import (
    DEFAULT_SITE_GEOFENCE_RADIUS_M,
    distance_meters,
    is_point_inside_site_geofence,
)

SITE_GEOFENCE_RADIUS_M = DEFAULT_SITE_GEOFENCE_RADIUS_M
PERSON_VEHICLE_MAX_DISTANCE_M = 2000
MIN_PRESENCE_DURATION_HOURS = 6
MIN_PRESENCE_DURATION = timedelta(hours=MIN_PRESENCE_DURATION_HOURS)


@dataclass(frozen=True)
class GpsTrackPoint:
    latitude: float
    longitude: float
    timestamp: datetime
    person_id: int | None = None
    vehicle_id: int | None = None


@dataclass(frozen=True)
class VehiclePersonAssignmentResult:
    person_id: int | None
    vehicle_id: int | None
    site_id: int | None
    date: date
    matched: bool
    confidence: str
    reason: str
    duration_minutes: int


def detect_vehicle_person_assignment(
    person_gps_points: list[GpsTrackPoint],
    vehicle_gps_points: list[GpsTrackPoint],
    site: object,
    day: date,
    team_context: list[int] | None = None,
) -> VehiclePersonAssignmentResult:
    person_id = _first_person_id(person_gps_points)
    vehicle_id = _first_vehicle_id(vehicle_gps_points)
    site_id = getattr(site, "id", None)

    if team_context is not None and len(set(team_context)) != 1:
        return VehiclePersonAssignmentResult(
            person_id, vehicle_id, site_id, day, False, "none", "not_unique_person_context", 0
        )

    person_on_site = _points_inside_site(person_gps_points, site)
    vehicle_on_site = _points_inside_site(vehicle_gps_points, site)
    if len(person_on_site) < 2 or len(vehicle_on_site) < 2:
        return VehiclePersonAssignmentResult(
            person_id, vehicle_id, site_id, day, False, "none", "insufficient_site_presence", 0
        )

    duration = min(_track_duration(person_on_site), _track_duration(vehicle_on_site))
    if duration < MIN_PRESENCE_DURATION:
        return VehiclePersonAssignmentResult(
            person_id,
            vehicle_id,
            site_id,
            day,
            False,
            "low",
            "presence_under_6h",
            int(duration.total_seconds() // 60),
        )

    if not _person_stays_near_vehicle(person_on_site, vehicle_on_site):
        return VehiclePersonAssignmentResult(
            person_id,
            vehicle_id,
            site_id,
            day,
            False,
            "medium",
            "person_vehicle_distance_over_2km",
            int(duration.total_seconds() // 60),
        )

    return VehiclePersonAssignmentResult(
        person_id,
        vehicle_id,
        site_id,
        day,
        True,
        "high",
        "person_and_vehicle_on_site_over_6h_within_2km",
        int(duration.total_seconds() // 60),
    )


def _points_inside_site(points: list[GpsTrackPoint], site: object) -> list[GpsTrackPoint]:
    return [point for point in points if is_point_inside_site_geofence(point, site).inside]


def _track_duration(points: list[GpsTrackPoint]) -> timedelta:
    ordered = sorted(points, key=lambda point: point.timestamp)
    return ordered[-1].timestamp - ordered[0].timestamp


def _person_stays_near_vehicle(
    person_points: list[GpsTrackPoint],
    vehicle_points: list[GpsTrackPoint],
) -> bool:
    ordered_vehicle = sorted(vehicle_points, key=lambda point: point.timestamp)
    for person_point in person_points:
        nearest_vehicle = min(
            ordered_vehicle,
            key=lambda vehicle_point: abs(vehicle_point.timestamp - person_point.timestamp),
        )
        distance = distance_meters(
            person_point.latitude,
            person_point.longitude,
            nearest_vehicle.latitude,
            nearest_vehicle.longitude,
        )
        if distance > PERSON_VEHICLE_MAX_DISTANCE_M:
            return False
    return True


def _first_person_id(points: list[GpsTrackPoint]) -> int | None:
    return next((point.person_id for point in points if point.person_id is not None), None)


def _first_vehicle_id(points: list[GpsTrackPoint]) -> int | None:
    return next((point.vehicle_id for point in points if point.vehicle_id is not None), None)
