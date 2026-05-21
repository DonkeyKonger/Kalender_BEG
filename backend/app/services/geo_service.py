from __future__ import annotations

from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from typing import Protocol

DEFAULT_SITE_GEOFENCE_RADIUS_M = 5000
EARTH_RADIUS_M = 6_371_000


class CoordinateLike(Protocol):
    latitude: float | None
    longitude: float | None


class SiteGeofenceLike(CoordinateLike, Protocol):
    geofence_radius_m: int | None


@dataclass(frozen=True)
class GeofenceCheckResult:
    inside: bool
    distance_m: float | None
    radius_m: int
    reason: str


def distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate air-line distance between two WGS84 coordinates using Haversine."""
    phi1 = radians(lat1)
    phi2 = radians(lat2)
    delta_phi = radians(lat2 - lat1)
    delta_lambda = radians(lon2 - lon1)

    haversine = sin(delta_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(delta_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(haversine))


def has_valid_coordinates(value: CoordinateLike) -> bool:
    return (
        value.latitude is not None
        and value.longitude is not None
        and -90 <= value.latitude <= 90
        and -180 <= value.longitude <= 180
    )


def is_point_inside_site_geofence(
    point: CoordinateLike,
    site: SiteGeofenceLike,
) -> GeofenceCheckResult:
    radius_m = site.geofence_radius_m or DEFAULT_SITE_GEOFENCE_RADIUS_M
    if not has_valid_coordinates(site):
        return GeofenceCheckResult(False, None, radius_m, "site_coordinates_missing")
    if not has_valid_coordinates(point):
        return GeofenceCheckResult(False, None, radius_m, "point_coordinates_missing")

    distance = distance_meters(point.latitude, point.longitude, site.latitude, site.longitude)
    return GeofenceCheckResult(
        inside=distance <= radius_m,
        distance_m=distance,
        radius_m=radius_m,
        reason="inside_geofence" if distance <= radius_m else "outside_geofence",
    )


def geocode_site_address(site: object) -> None:
    """Placeholder for a later geocoding provider integration.

    V1 supports manually maintained coordinates. A future provider must be wired
    through configuration, never with hardcoded API keys.
    """
    return None
