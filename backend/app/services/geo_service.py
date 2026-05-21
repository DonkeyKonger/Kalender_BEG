from __future__ import annotations

from dataclasses import dataclass
import json
from math import asin, cos, radians, sin, sqrt
from typing import Protocol
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_SITE_GEOFENCE_RADIUS_M = 5000
EARTH_RADIUS_M = 6_371_000
NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
GEOCODING_USER_AGENT = "Kalender-Baustellen/1.0"


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


@dataclass(frozen=True)
class GeocodingCandidate:
    latitude: float
    longitude: float
    label: str
    postal_code: str | None = None
    city: str | None = None
    street: str | None = None
    house_number: str | None = None
    confidence: float | None = None
    source: str = "nominatim"


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


def geocode_site_address(site: object) -> list[GeocodingCandidate]:
    query = site_address_query(site)
    if not query:
        return []
    return fetch_geocoding_candidates(query, limit=2)


def search_geocoding_candidates(query: str, limit: int = 5) -> list[GeocodingCandidate]:
    clean_query = query.strip()
    if len(clean_query) < 3:
        return []
    return fetch_geocoding_candidates(clean_query, limit=limit)


def site_address_query(site: object) -> str | None:
    street = " ".join(
        value
        for value in [getattr(site, "street", None), getattr(site, "house_number", None)]
        if value
    )
    parts = [
        street or getattr(site, "address", None),
        getattr(site, "postal_code", None),
        getattr(site, "city", None) or getattr(site, "location", None),
        "Deutschland",
    ]
    query = ", ".join(str(part).strip() for part in parts if part and str(part).strip())
    return query or None


def fetch_geocoding_candidates(query: str, limit: int = 5) -> list[GeocodingCandidate]:
    params = urlencode({"q": query, "format": "jsonv2", "limit": str(limit), "addressdetails": "1"})
    request = Request(
        f"{NOMINATIM_SEARCH_URL}?{params}",
        headers={"User-Agent": GEOCODING_USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, TimeoutError, json.JSONDecodeError):
        return []

    candidates = [candidate for item in payload[:limit] if (candidate := geocoding_candidate_from_payload(item, query))]
    return sorted(candidates, key=lambda candidate: candidate.confidence or 0, reverse=True)


def geocoding_candidate_from_payload(item: dict, fallback_label: str) -> GeocodingCandidate | None:
    try:
        latitude = float(item["lat"])
        longitude = float(item["lon"])
    except (KeyError, TypeError, ValueError):
        return None

    address = item.get("address") if isinstance(item.get("address"), dict) else {}
    city = first_present(address, "city", "town", "village", "municipality", "hamlet")
    street = first_present(address, "road", "pedestrian", "footway", "residential", "path")
    house_number = first_present(address, "house_number")
    postal_code = first_present(address, "postcode")
    confidence = parse_float(item.get("importance"))

    return GeocodingCandidate(
        latitude=latitude,
        longitude=longitude,
        label=str(item.get("display_name") or fallback_label),
        postal_code=postal_code,
        city=city,
        street=street,
        house_number=house_number,
        confidence=confidence,
    )


def first_present(values: dict, *keys: str) -> str | None:
    for key in keys:
        value = values.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def parse_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
