from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import SiteStatus
from app.services.site_service import clean_site_values, site_snapshot


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
        customer="Badener Elektro",
        project_manager_person_id=3,
        status=SiteStatus.CLOSED,
        info=None,
        color="#1d5c99",
        closed_at=closed_at,
        closed_by_user_id=4,
    )

    snapshot = site_snapshot(site)

    assert snapshot["status"] == "closed"
    assert snapshot["closed_at"] == "2026-05-20T10:15:00+00:00"
