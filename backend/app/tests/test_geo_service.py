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


def test_isolated_search_reports_unavailable_without_network(monkeypatch):
    import pytest

    monkeypatch.setenv("LOCAL_TEST_MODE", "isolated")
    monkeypatch.setattr(geo_service, "urlopen", lambda *args, **kwargs: pytest.fail("Unexpected external request"))
    with pytest.raises(geo_service.GeocodingUnavailableError, match="lokalen Testkalender"):
        search_geocoding_candidates("Berlin")


def test_provider_failure_is_not_an_empty_search_result(monkeypatch):
    import pytest
    from urllib.error import URLError

    monkeypatch.delenv("LOCAL_TEST_MODE", raising=False)
    def unavailable(*args, **kwargs):
        raise URLError("DNS unavailable")
    monkeypatch.setattr(geo_service, "urlopen", unavailable)
    with pytest.raises(geo_service.GeocodingUnavailableError, match="nicht erreichbar"):
        search_geocoding_candidates("Berlin")
    assert geo_service.geocode_site_address(SimpleNamespace(city="Berlin")) == []


def test_provider_empty_result_remains_empty(monkeypatch):
    from io import BytesIO

    monkeypatch.delenv("LOCAL_TEST_MODE", raising=False)
    monkeypatch.setattr(geo_service, "urlopen", lambda *args, **kwargs: BytesIO(b"[]"))
    assert search_geocoding_candidates("Berlin") == []


def test_provider_invalid_payload_reports_unavailable(monkeypatch):
    import pytest
    from io import BytesIO

    monkeypatch.delenv("LOCAL_TEST_MODE", raising=False)
    for payload in (b'{"error":"unavailable"}', b'not json', b'null'):
        monkeypatch.setattr(geo_service, "urlopen", lambda *args, **kwargs: BytesIO(payload))
        with pytest.raises(geo_service.GeocodingUnavailableError):
            search_geocoding_candidates("Berlin")


def test_geocoding_routes_return_service_unavailable(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.api.routes import sites, persons

    def unavailable(*args, **kwargs):
        raise geo_service.GeocodingUnavailableError("Adresssuche benötigt Internetzugang.")
    for module, endpoint in ((sites, sites.search_site_geocode), (persons, persons.search_person_geocode)):
        monkeypatch.setattr(module, "search_geocoding_candidates", unavailable)
        with pytest.raises(HTTPException) as failure:
            endpoint(q="Berlin", limit=5)
        assert failure.value.status_code == 503
        assert failure.value.detail == "Adresssuche benötigt Internetzugang."
