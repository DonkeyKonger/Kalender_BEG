from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import PersonEmploymentStatus, PersonType, SiteLocationStatus
from app.services.person_service import PersonService, apply_selected_person_geocode, clean_person_values, person_snapshot


def test_clean_person_values_generates_display_name_and_calendar_search_code():
    values = clean_person_values(
        {
            "first_name": " Noah ",
            "last_name": " Stern ",
            "display_name": " ",
            "short_code": " ",
        }
    )

    assert values["display_name"] == "Noah Stern"
    assert values["short_code"] == "N.Stern"


def test_clean_person_values_derives_calendar_search_code_from_name():
    values = clean_person_values(
        {
            "first_name": "Christopher",
            "last_name": "Erichsen",
            "display_name": "Christopher Erichsen",
            "short_code": "CE",
        }
    )

    assert values["short_code"] == "C.Erichsen"


def test_clean_person_values_rejects_blank_required_fields():
    with pytest.raises(HTTPException) as error:
        clean_person_values({"first_name": "   "})

    assert error.value.status_code == 400


def test_person_snapshot_uses_json_safe_enum_value():
    person = SimpleNamespace(
        id=1,
        first_name="Noah",
        last_name="Stern",
        display_name="Noah Stern",
        short_code="N.Stern",
        person_type=PersonType.INTERNAL,
        is_active=True,
        employment_status=PersonEmploymentStatus.ACTIVE.value,
        email=None,
        phone=None,
        notes=None,
    )

    assert person_snapshot(person)["person_type"] == "internal"


def test_apply_selected_person_geocode_keeps_selected_coordinates():
    values = {
        "address_formatted": "Moorburger Strasse 16, Hamburg",
        "address_latitude": 53.456,
        "address_longitude": 9.987,
        "address_location_status": SiteLocationStatus.GEOCODED,
    }

    assert apply_selected_person_geocode(values) is True
    assert values["address_latitude"] == 53.456
    assert values["address_location_status"] == SiteLocationStatus.GEOCODED


def test_apply_selected_person_geocode_strips_unchecked_coordinates():
    values = {
        "address_latitude": 53.456,
        "address_longitude": 9.987,
        "address_location_status": SiteLocationStatus.UNCHECKED,
    }

    assert apply_selected_person_geocode(values) is False
    assert "address_latitude" not in values
    assert "address_longitude" not in values
    assert values["address_location_status"] == SiteLocationStatus.UNCHECKED


def test_person_dependency_check_keeps_empty_person_deletable():
    service = PersonService.__new__(PersonService)
    service._has_row = lambda *args: False
    person = SimpleNamespace(id=1)

    assert service._person_has_dependencies(person) is False


def test_person_dependency_check_keeps_person_with_location_soft_removable():
    service = PersonService.__new__(PersonService)
    service._has_row = lambda *args: False
    person = SimpleNamespace(id=1, address_city="Achim")

    assert service._person_has_dependencies(person) is True


def test_clean_person_values_preserves_explicit_paused_status():
    values = clean_person_values(
        {
            "first_name": "Noah",
            "last_name": "Stern",
            "display_name": "Noah Stern",
            "short_code": "N.Stern",
            "is_active": False,
            "employment_status": PersonEmploymentStatus.PAUSED,
        }
    )

    assert values["employment_status"] == "paused"
    assert values["is_active"] is False


def test_clean_person_values_maps_legacy_inactive_to_departed():
    values = clean_person_values(
        {
            "first_name": "Noah",
            "last_name": "Stern",
            "display_name": "Noah Stern",
            "short_code": "N.Stern",
            "is_active": False,
        }
    )

    assert values["employment_status"] == "departed"
