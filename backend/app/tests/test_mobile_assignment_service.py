from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import SiteStatus, UserRole
from app.models.site import Site
from app.services.mobile_assignment_service import MobileAssignmentService


def test_mobile_active_sites_are_readable_for_assigned_monteur():
    site = Site(id=7, site_number="8007", name="Projekt X", status=SiteStatus.ACTIVE)
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = SimpleNamespace(scalars=lambda statement: [site])

    sites = service.list_active_sites_for_mobile(
        current_user=SimpleNamespace(role=UserRole.MONTEUR, person_id=3),
    )

    assert len(sites) == 1
    assert sites[0].id == 7
    assert sites[0].site_number == "8007"
    assert sites[0].name == "Projekt X"


def test_mobile_active_sites_require_person_for_monteur():
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = SimpleNamespace(scalars=lambda statement: [])

    with pytest.raises(HTTPException) as error:
        service.list_active_sites_for_mobile(
            current_user=SimpleNamespace(role=UserRole.MONTEUR, person_id=None),
        )

    assert error.value.status_code == 403
