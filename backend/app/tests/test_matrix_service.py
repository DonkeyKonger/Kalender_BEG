from datetime import date

import pytest
from fastapi import HTTPException

from app.services.matrix_service import MatrixService


class FakeSites:
    def list(self, *, include_closed=False):
        return []


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
