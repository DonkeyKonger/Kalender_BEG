from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.dashboard_note import DashboardNote
from app.models.enums import SiteStatus, UserRole
from app.models.site import Site
from app.models.user import User
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


def test_matrix_aggregates_open_site_notes_for_current_user_and_updates_version():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    owner = User(
        username="owner",
        display_name="Owner",
        password_hash="x",
        role=UserRole.PROJECT_MANAGER,
        is_active=True,
    )
    other_user = User(
        username="other",
        display_name="Other",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
    )
    first_site = Site(site_number="1001", name="Erste Baustelle", status=SiteStatus.ACTIVE)
    second_site = Site(site_number="1002", name="Zweite Baustelle", status=SiteStatus.ACTIVE)
    db.add_all([owner, other_user, first_site, second_site])
    db.flush()
    notes = [
        DashboardNote(text="Offen 1", site_id=first_site.id, created_by_user_id=owner.id, completed=False),
        DashboardNote(text="Offen 2", site_id=first_site.id, created_by_user_id=owner.id, completed=False),
        DashboardNote(text="Offen 3", site_id=second_site.id, created_by_user_id=owner.id, completed=False),
        DashboardNote(text="Erledigt", site_id=first_site.id, created_by_user_id=owner.id, completed=True),
        DashboardNote(text="Fremd", site_id=first_site.id, created_by_user_id=other_user.id, completed=False),
        DashboardNote(text="Ohne Baustelle", created_by_user_id=owner.id, completed=False),
        DashboardNote(
            text="Gelöscht",
            site_id=first_site.id,
            created_by_user_id=owner.id,
            completed=False,
            deleted_at=datetime.now(timezone.utc),
        ),
    ]
    db.add_all(notes)
    db.commit()

    service = MatrixService(db)
    result = service.get_matrix(
        start=date(2026, 7, 13),
        end=date(2026, 7, 13),
        include_weekends=True,
        user_id=owner.id,
    )
    counts = {row.site.id: row.site.open_note_count for row in result.rows}

    assert counts == {first_site.id: 2, second_site.id: 1}

    version_before = service.get_version(
        start=date(2026, 7, 13),
        end=date(2026, 7, 13),
        user_id=owner.id,
    ).version
    notes[0].completed = True
    db.commit()

    updated_result = service.get_matrix(
        start=date(2026, 7, 13),
        end=date(2026, 7, 13),
        include_weekends=True,
        user_id=owner.id,
    )
    updated_counts = {row.site.id: row.site.open_note_count for row in updated_result.rows}
    version_after = service.get_version(
        start=date(2026, 7, 13),
        end=date(2026, 7, 13),
        user_id=owner.id,
    ).version

    assert updated_counts == {first_site.id: 1, second_site.id: 1}
    assert version_after != version_before


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
