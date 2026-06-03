from types import SimpleNamespace

import app.services.geo_service as geo_service
from app.services.geo_service import (
    DEFAULT_SITE_GEOFENCE_RADIUS_M,
    distance_meters,
    geocoding_candidate_from_payload,
    has_valid_coordinates,
    is_point_inside_site_geofence,
    search_geocoding_candidates,
    site_address_query,
)


def test_distance_meters_returns_reasonable_air_line_distance():
    distance = distance_meters(53.0142, 9.0263, 53.0242, 9.0263)

    assert 1100 <= distance <= 1120


def test_geofence_accepts_point_inside_default_3km_radius():
    site = SimpleNamespace(latitude=53.0142, longitude=9.0263, geofence_radius_m=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    point = SimpleNamespace(latitude=53.0242, longitude=9.0263)

    result = is_point_inside_site_geofence(point, site)

    assert result.inside is True
    assert result.reason == "inside_geofence"
    assert result.radius_m == 3000


def test_geofence_rejects_point_outside_default_3km_radius():
    site = SimpleNamespace(latitude=53.0142, longitude=9.0263, geofence_radius_m=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    point = SimpleNamespace(latitude=53.1142, longitude=9.0263)

    result = is_point_inside_site_geofence(point, site)

    assert result.inside is False
    assert result.distance_m is not None
    assert result.distance_m > 3000
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

    def fake_fetch(query: str, limit: int = 5):
        calls.append((query, limit))
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

    assert calls == [("Hauptstrasse 12, 28832, Achim, Deutschland", 2)]
    assert result[0].latitude == 53.0


def test_geocoding_candidate_from_payload_extracts_address_details():
    payload = {
        "lat": "53.456",
        "lon": "9.987",
        "display_name": "Moorburger Strasse 16, Hamburg",
        "importance": 0.73,
        "address": {
            "postcode": "21079",
            "city": "Hamburg",
            "road": "Moorburger Strasse",
            "house_number": "16",
        },
    }

    candidate = geocoding_candidate_from_payload(payload, "Moorburger")

    assert candidate is not None
    assert candidate.label == "Moorburger Strasse 16, Hamburg"
    assert candidate.postal_code == "21079"
    assert candidate.city == "Hamburg"
    assert candidate.street == "Moorburger Strasse"
    assert candidate.house_number == "16"
    assert candidate.confidence == 0.73
    assert candidate.source == "nominatim"


def test_search_geocoding_candidates_ignores_short_queries(monkeypatch):
    calls = []

    def fake_fetch(query: str, limit: int = 5):
        calls.append((query, limit))
        return []

    monkeypatch.setattr(geo_service, "fetch_geocoding_candidates", fake_fetch)

    assert search_geocoding_candidates("ab") == []
    assert calls == []


def test_search_geocoding_candidates_delegates_to_fetcher(monkeypatch):
    calls = []

    def fake_fetch(query: str, limit: int = 5):
        calls.append((query, limit))
        return [geo_service.GeocodingCandidate(53.0, 9.0, "Treffer", city="Hamburg")]

    monkeypatch.setattr(geo_service, "fetch_geocoding_candidates", fake_fetch)

    result = search_geocoding_candidates(" Moorburger Strasse ", limit=4)

    assert calls == [("Moorburger Strasse", 4)]
    assert result[0].city == "Hamburg"
