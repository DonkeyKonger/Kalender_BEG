from types import SimpleNamespace

from app.services.geo_service import (
    DEFAULT_SITE_GEOFENCE_RADIUS_M,
    distance_meters,
    has_valid_coordinates,
    is_point_inside_site_geofence,
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
