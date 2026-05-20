from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import PersonType
from app.services.person_service import clean_person_values, person_snapshot


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
        email=None,
        phone=None,
        notes=None,
    )

    assert person_snapshot(person)["person_type"] == "internal"
