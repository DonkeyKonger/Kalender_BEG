from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app.services.mobile_assignment_service as mobile_assignment_module
from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import AssignmentType, SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.mobile import MobileSelfPlanRequest
from app.services.mobile_assignment_service import MobileAssignmentService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def test_mobile_assignment_history_includes_closed_sites_and_only_own_person():
    db = db_session()
    worker = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    other_worker = Person(first_name="Erika", last_name="Extern", display_name="Erika Extern", short_code="EE")
    current_user = User(
        username="max.monteur",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        is_active=True,
        person=worker,
    )
    active_site = Site(site_number="1001", name="Aktive Baustelle", status=SiteStatus.ACTIVE)
    completed_site = Site(site_number="1002", name="Abgeschlossene Baustelle", status=SiteStatus.COMPLETED)
    deleted_site = Site(site_number="1003", name="Archivierte Baustelle", status=SiteStatus.DELETED)
    db.add_all([worker, other_worker, current_user, active_site, completed_site, deleted_site])
    db.flush()
    db.add_all([
        Assignment(
            site_id=active_site.id,
            person_id=worker.id,
            start_date=date(2026, 7, 10),
            end_date=date(2026, 7, 13),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=completed_site.id,
            person_id=worker.id,
            start_date=date(2025, 8, 1),
            end_date=date(2025, 8, 4),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=deleted_site.id,
            person_id=worker.id,
            start_date=date(2026, 1, 12),
            end_date=date(2026, 1, 12),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=active_site.id,
            person_id=worker.id,
            start_date=date(2025, 7, 1),
            end_date=date(2025, 7, 12),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=active_site.id,
            person_id=other_worker.id,
            start_date=date(2026, 5, 1),
            end_date=date(2026, 5, 2),
            assignment_type=AssignmentType.REGULAR,
        ),
    ])
    db.commit()

    response = MobileAssignmentService(db).list_own_assignments(
        current_user=current_user,
        start=date(2025, 7, 13),
        end=date(2026, 7, 13),
        allow_history=True,
    )

    assert response.start_date == date(2025, 7, 13)
    assert response.end_date == date(2026, 7, 13)
    assert {assignment.site.name for assignment in response.assignments} == {
        "Aktive Baustelle",
        "Abgeschlossene Baustelle",
        "Archivierte Baustelle",
    }
    assert {assignment.person.id for assignment in response.assignments} == {worker.id}


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


class FakeScalarDb:
    def __init__(self, values):
        self.values = list(values)

    def scalar(self, statement):
        return self.values.pop(0)


class FakeAssignmentService:
    calls = []

    def __init__(self, db):
        self.db = db

    def create_assignment(self, payload, user_id, audit_action="assignment.created"):
        self.__class__.calls.append({
            "payload": payload,
            "user_id": user_id,
            "audit_action": audit_action,
        })
        site = mobile_site(17, status=SiteStatus.ACTIVE)
        person = mobile_person(4)
        assignment = SimpleNamespace(
            id=99,
            start_date=payload.start_date,
            end_date=payload.end_date,
            assignment_type=payload.assignment_type,
            note=payload.note,
            person=person,
            site=site,
        )
        return SimpleNamespace(assignment=assignment)


def mobile_person(person_id):
    return SimpleNamespace(
        id=person_id,
        display_name="Christopher Erichsen",
        phone=None,
        email=None,
        can_sign_measurements_immediately=False,
    )


def mobile_site(site_id, status=SiteStatus.ACTIVE):
    return SimpleNamespace(
        id=site_id,
        site_number="8007",
        name="Schüchtermann Klinik",
        location="Bad Rothenfelde",
        address=None,
        customer="ebm",
        project_manager=None,
        status=status,
        info=None,
    )


def test_mobile_self_plan_requires_monteur_person():
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = FakeScalarDb([])

    with pytest.raises(HTTPException) as error:
        service.self_plan_assignment(
            current_user=SimpleNamespace(id=3, role=UserRole.MONTEUR, person_id=None),
            payload=MobileSelfPlanRequest(site_id=17, work_date=date(2026, 6, 11)),
        )

    assert error.value.status_code == 403


def test_mobile_self_plan_creates_self_planned_assignment(monkeypatch):
    FakeAssignmentService.calls = []
    monkeypatch.setattr(mobile_assignment_module, "AssignmentService", FakeAssignmentService)
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = FakeScalarDb([mobile_site(17), 12, None])

    assignment = service.self_plan_assignment(
        current_user=SimpleNamespace(id=3, role=UserRole.MONTEUR, person_id=4),
        payload=MobileSelfPlanRequest(site_id=17, work_date=date(2026, 6, 11)),
    )

    call = FakeAssignmentService.calls[0]
    assert call["user_id"] == 3
    assert call["audit_action"] == "assignment.mobile_self_planned"
    assert call["payload"].person_id == 4
    assert call["payload"].assignment_type == AssignmentType.SELF_PLANNED
    assert assignment.assignment_type == AssignmentType.SELF_PLANNED


def test_mobile_self_plan_rejects_site_that_is_not_known_for_worker(monkeypatch):
    FakeAssignmentService.calls = []
    monkeypatch.setattr(mobile_assignment_module, "AssignmentService", FakeAssignmentService)
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = FakeScalarDb([mobile_site(17), None])

    with pytest.raises(HTTPException) as error:
        service.self_plan_assignment(
            current_user=SimpleNamespace(id=3, role=UserRole.MONTEUR, person_id=4),
            payload=MobileSelfPlanRequest(site_id=17, work_date=date(2026, 6, 11)),
        )

    assert error.value.status_code == 403
    assert FakeAssignmentService.calls == []


def test_mobile_self_plan_allows_known_future_or_planned_site(monkeypatch):
    FakeAssignmentService.calls = []
    monkeypatch.setattr(mobile_assignment_module, "AssignmentService", FakeAssignmentService)
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = FakeScalarDb([mobile_site(17, status=SiteStatus.PLANNED), 21, None])

    assignment = service.self_plan_assignment(
        current_user=SimpleNamespace(id=3, role=UserRole.MONTEUR, person_id=4),
        payload=MobileSelfPlanRequest(site_id=17, work_date=date(2026, 6, 11)),
    )

    assert assignment.assignment_type == AssignmentType.SELF_PLANNED
    assert len(FakeAssignmentService.calls) == 1


def test_mobile_self_plan_returns_existing_duplicate(monkeypatch):
    FakeAssignmentService.calls = []
    monkeypatch.setattr(mobile_assignment_module, "AssignmentService", FakeAssignmentService)
    existing = SimpleNamespace(
        id=42,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
        assignment_type=AssignmentType.REGULAR,
        note=None,
        person=mobile_person(4),
        site=mobile_site(17),
    )
    service = MobileAssignmentService.__new__(MobileAssignmentService)
    service.db = FakeScalarDb([mobile_site(17), 12, existing])

    assignment = service.self_plan_assignment(
        current_user=SimpleNamespace(id=3, role=UserRole.MONTEUR, person_id=4),
        payload=MobileSelfPlanRequest(site_id=17, work_date=date(2026, 6, 11)),
    )

    assert assignment.id == 42
    assert FakeAssignmentService.calls == []
