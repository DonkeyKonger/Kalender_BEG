import pytest
from fastapi import HTTPException

from app.services.external_person_service import external_person_name_parts


def test_external_person_name_parts_split_full_name_for_valid_person_record():
    values = external_person_name_parts("  Max   Mustermann  ")

    assert values == {
        "first_name": "Max",
        "last_name": "Mustermann",
        "display_name": "Max Mustermann",
        "short_code": "M.Mustermann",
    }


def test_external_person_name_parts_keeps_single_name_schema_safe():
    values = external_person_name_parts("Leihmann")

    assert values == {
        "first_name": "Leihmann",
        "last_name": "Leihmann",
        "display_name": "Leihmann",
        "short_code": "L.Leihmann",
    }


def test_external_person_name_parts_rejects_blank_name():
    with pytest.raises(HTTPException) as error:
        external_person_name_parts("   ")

    assert error.value.status_code == 400
