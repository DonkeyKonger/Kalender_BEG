from types import SimpleNamespace

import app.services.geo_service as geo_service
from app.services.geo_service import (
    DEFAULT_SITE_GEOFENCE_RADIUS_M,
    distance_meters,
    has_valid_coordinates,
    is_point_inside_site_geofence,
    site_address_query,
)


def test_distance_meters_returns_reasonable_air_line_distance():
    distance = distance_meters(53.0142, 9.0263, 53.0242, 9.0263)

    assert 1100 <= distance <= 1120


def test_geofence_accepts_point_inside_default_5km_radius():
    site = SimpleNamespace(latitude=53.0142, longitude=9.0263, geofence_radius_m=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    point = SimpleNamespace(latitude=53.0242, longitude=9.0263)

    result = is_point_inside_site_geofence(point, site)

    assert result.inside is True
    assert result.reason == "inside_geofence"
    assert result.radius_m == 5000


def test_geofence_rejects_point_outside_default_5km_radius():
    site = SimpleNamespace(latitude=53.0142, longitude=9.0263, geofence_radius_m=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    point = SimpleNamespace(latitude=53.1142, longitude=9.0263)

    result = is_point_inside_site_geofence(point, site)

    assert result.inside is False
    assert result.distance_m is not None
    assert result.distance_m > 5000
    assert result.reason == "outside_geofence"


def test_geofence_handles_missing_site_coordinates():
    site = SimpleNamespace(latitude=None, longitude=None, geofence_radius_m=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    point = SimpleNamespace(latitude=53.0142, longitude=9.0263)

    result = is_point_inside_site_geofence(point, site)

    assert result.inside is False
    assert result.distance_m is None
    assert result.reason == "site_coordinates_missing"
    assert has_valid_coordinates(site) is False


def test_site_address_query_prefers_structured_street_and_house_number():
    site = SimpleNamespace(
        street="Hauptstrasse",
        house_number="12",
        address="Alte Adresse",
        postal_code="28832",
        city="Achim",
        location="Achim",
    )

    assert site_address_query(site) == "Hauptstrasse 12, 28832, Achim, Deutschland"


def test_geocode_site_address_delegates_to_fetcher(monkeypatch):
    calls = []

    def fake_fetch(query: str):
        calls.append(query)
        return [geo_service.GeocodingCandidate(53.0, 9.0, "Treffer")]

    monkeypatch.setattr(geo_service, "fetch_geocoding_candidates", fake_fetch)
    site = SimpleNamespace(
        street="Hauptstrasse",
        house_number="12",
        address=None,
        postal_code="28832",
        city="Achim",
        location=None,
    )

    result = geo_service.geocode_site_address(site)

    assert calls == ["Hauptstrasse 12, 28832, Achim, Deutschland"]
    assert result[0].latitude == 53.0
