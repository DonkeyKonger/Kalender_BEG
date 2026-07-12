from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.matrix_service import MatrixService


class FakeSites:
    def __init__(self, sites=None):
        self.sites = sites or []
        self.list_calls = 0

    def list(self, *, include_closed=False):
        self.list_calls += 1
        return self.sites


class FakeAssignments:
    def list(self, *, start=None, end=None, person_id=None, site_id=None):
        return []


class FakeAbsences:
    def list(self, *, start=None, end=None, person_id=None):
        return []


def matrix_service():
    service = MatrixService.__new__(MatrixService)
    service.sites = FakeSites()
    service.assignments = FakeAssignments()
    service.absences = FakeAbsences()
    service._list_marks = lambda *, site_ids, start, end: {}
    return service


def test_matrix_standard_range_still_rejects_more_than_90_days():
    with pytest.raises(HTTPException) as error:
        matrix_service().get_matrix(
            start=date(2026, 1, 1),
            end=date(2026, 4, 1),
            include_weekends=True,
        )

    assert error.value.status_code == 400
    assert error.value.detail == "Matrixzeitraum ist zu gross."


def test_matrix_year_view_allows_full_year_range():
    result = matrix_service().get_matrix(
        start=date(2026, 1, 1),
        end=date(2026, 12, 31),
        include_weekends=True,
        year_view=True,
    )

    assert result.start_date == date(2026, 1, 1)
    assert result.end_date == date(2026, 12, 31)
    assert len(result.days) == 365
    assert result.rows == []


def test_matrix_project_manager_filter_reuses_loaded_sites():
    sites = FakeSites(
        [
            matrix_site(1, project_manager_person_id=10),
            matrix_site(2, project_manager_person_id=20),
            matrix_site(3, project_manager_person_id=10),
        ]
    )
    service = matrix_service()
    service.sites = sites

    result = service.get_matrix(
        start=date(2026, 7, 6),
        end=date(2026, 7, 6),
        include_weekends=True,
        project_manager_person_id=10,
    )

    assert sites.list_calls == 1
    assert [row.site.id for row in result.rows] == [1, 3]


def matrix_site(site_id: int, *, project_manager_person_id: int):
    return SimpleNamespace(
        id=site_id,
        site_number=str(site_id),
        name=f"Baustelle {site_id}",
        location=None,
        customer=None,
        project_manager_person_id=project_manager_person_id,
        project_manager=None,
        status="active",
        info=None,
        color=None,
    )
