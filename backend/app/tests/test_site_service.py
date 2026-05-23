from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import SiteLocationStatus, SiteStatus
from app.services.site_service import SiteService, apply_selected_geocode, clean_site_values, has_valid_map_location, site_map_item, site_snapshot


def test_clean_site_values_trims_name_and_turns_blank_optional_text_to_none():
    values = clean_site_values(
        {
            "name": "  Neubau Halle  ",
            "location": "   ",
            "customer": "  Badener Elektro  ",
        }
    )

    assert values["name"] == "Neubau Halle"
    assert values["location"] is None
    assert values["customer"] == "Badener Elektro"


def test_clean_site_values_rejects_blank_name():
    with pytest.raises(HTTPException) as error:
        clean_site_values({"name": "  "})

    assert error.value.status_code == 400


def test_site_snapshot_uses_json_safe_status_and_dates():
    closed_at = datetime(2026, 5, 20, 10, 15, tzinfo=UTC)
    site = SimpleNamespace(
        id=1,
        site_number="B-100",
        name="Neubau Halle",
        location="Baden",
        address=None,
        postal_code="28832",
        city="Achim",
        street="Hauptstrasse",
        house_number="12",
        address_extra="Halle links",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
        location_status=SiteLocationStatus.GEOCODED,
        customer="Badener Elektro",
        project_manager_person_id=3,
        status=SiteStatus.COMPLETED,
        info=None,
        color="#1d5c99",
        closed_at=closed_at,
        closed_by_user_id=4,
    )

    snapshot = site_snapshot(site)

    assert snapshot["status"] == "completed"
    assert snapshot["location_status"] == "geocoded"
    assert snapshot["geofence_radius_m"] == 5000
    assert snapshot["closed_at"] == "2026-05-20T10:15:00+00:00"


def test_has_valid_map_location_requires_coordinates_and_geocoded_status():
    site = SimpleNamespace(
        latitude=53.0142,
        longitude=9.0263,
        location_status=SiteLocationStatus.GEOCODED,
    )

    assert has_valid_map_location(site) is True

    site.location_status = SiteLocationStatus.UNCHECKED
    assert has_valid_map_location(site) is False

    site.location_status = SiteLocationStatus.GEOCODED
    site.longitude = None
    assert has_valid_map_location(site) is False


def test_site_map_item_returns_only_slim_map_fields():
    project_manager = SimpleNamespace(
        id=7,
        display_name="Christopher Erichsen",
        short_code="CE",
        email=None,
        phone=None,
    )
    site = SimpleNamespace(
        id=12,
        site_number="8014",
        name="FTZ Verden",
        city="Verden",
        location="Verden",
        postal_code="27283",
        street="Hauptstrasse",
        house_number="5",
        project_manager=project_manager,
        status=SiteStatus.ACTIVE,
        color="#1d5c99",
        latitude=52.9234,
        longitude=9.2345,
        geofence_radius_m=5000,
        location_status=SiteLocationStatus.GEOCODED,
    )

    item = site_map_item(site)

    assert item.id == 12
    assert item.number == "8014"
    assert item.city == "Verden"
    assert item.project_manager is not None
    assert item.project_manager.short_code == "CE"
    assert item.latitude == 52.9234
    assert item.geofence_radius_m == 5000


def test_apply_selected_geocode_keeps_coordinates_only_for_geocoded_selection():
    values = {
        "postal_code": "21079",
        "latitude": 53.456,
        "longitude": 9.987,
        "location_status": SiteLocationStatus.GEOCODED,
    }

    assert apply_selected_geocode(values) is True
    assert values["latitude"] == 53.456
    assert values["location_status"] == SiteLocationStatus.GEOCODED


def test_apply_selected_geocode_strips_manual_technical_location_fields():
    values = {
        "postal_code": "21079",
        "latitude": 53.456,
        "longitude": 9.987,
        "location_status": SiteLocationStatus.UNCHECKED,
    }

    assert apply_selected_geocode(values) is False
    assert "latitude" not in values
    assert "longitude" not in values
    assert values["location_status"] == SiteLocationStatus.UNCHECKED


def test_apply_selected_geocode_leaves_unrelated_updates_alone():
    values = {"customer": "Badener Elektro"}

    assert apply_selected_geocode(values) is False
    assert values == {"customer": "Badener Elektro"}


def test_site_dependency_check_keeps_empty_site_deletable():
    service = SiteService.__new__(SiteService)
    service._has_row = lambda *args: False
    site = SimpleNamespace(id=1, location=None, address=None, postal_code=None, city=None, street=None, house_number=None, address_extra=None, latitude=None, longitude=None)

    assert service._site_has_dependencies(site) is False


def test_site_dependency_check_keeps_site_with_location_archivable():
    service = SiteService.__new__(SiteService)
    service._has_row = lambda *args: False
    site = SimpleNamespace(id=1, location="Hamburg", address=None, postal_code=None, city=None, street=None, house_number=None, address_extra=None, latitude=None, longitude=None)

    assert service._site_has_dependencies(site) is True
