from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app.services.mobile_assignment_service as mobile_assignment_module
from app.api.routes.me import list_my_assignment_history, list_my_assignments
from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import AssignmentType, SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.assignment import AssignmentCreate, AssignmentUpdate
from app.schemas.mobile import MobileSelfPlanRequest
from app.services.assignment_service import AssignmentService
from app.services.mobile_assignment_service import MobileAssignmentService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def history_context() -> tuple[Session, User, Person, Person]:
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
    db.add_all([worker, other_worker, current_user])
    db.flush()
    db.commit()
    return db, current_user, worker, other_worker


def add_history_assignment(
    db: Session,
    *,
    person: Person,
    site_number: str,
    work_date: date,
    end_date: date | None = None,
    site_status: SiteStatus = SiteStatus.ACTIVE,
) -> Assignment:
    site = Site(
        site_number=site_number,
        name=f"Baustelle {site_number}",
        status=site_status,
    )
    db.add(site)
    db.flush()
    assignment = Assignment(
        site_id=site.id,
        person_id=person.id,
        start_date=work_date,
        end_date=end_date or work_date,
        assignment_type=AssignmentType.REGULAR,
    )
    db.add(assignment)
    db.commit()
    return assignment


def load_history(db: Session, current_user: User):
    return MobileAssignmentService(db).list_own_assignment_history(
        current_user=current_user,
        start=date(2025, 7, 14),
        end=date(2026, 7, 14),
    )


def test_mobile_assignment_history_includes_single_past_planmatrix_day():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="1001",
        work_date=date(2026, 5, 12),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [assignment.id]


def test_mobile_assignment_history_returns_multiple_entries_for_same_site():
    db, current_user, worker, _ = history_context()
    site = Site(site_number="1002", name="Mehrfach eingeplant", status=SiteStatus.ACTIVE)
    db.add(site)
    db.flush()
    assignments = [
        Assignment(
            site_id=site.id,
            person_id=worker.id,
            start_date=work_date,
            end_date=work_date,
            assignment_type=AssignmentType.REGULAR,
        )
        for work_date in [date(2026, 2, 3), date(2026, 5, 12)]
    ]
    db.add_all(assignments)
    db.commit()

    response = load_history(db, current_user)

    assert {item.id for item in response.assignments} == {item.id for item in assignments}
    assert {item.site.id for item in response.assignments} == {site.id}


def test_mobile_assignment_history_includes_multiday_assignment_run():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="run-kw27",
        work_date=date(2026, 6, 29),
        end_date=date(2026, 7, 3),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [assignment.id]
    assert response.assignments[0].start_date == date(2026, 6, 29)
    assert response.assignments[0].end_date == date(2026, 7, 3)


def test_mobile_assignment_history_includes_run_starting_before_requested_range():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="overlap-start",
        work_date=date(2025, 7, 10),
        end_date=date(2025, 7, 15),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [assignment.id]


def test_mobile_assignment_history_includes_run_ending_after_requested_range():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="overlap-end",
        work_date=date(2026, 7, 13),
        end_date=date(2026, 7, 20),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [assignment.id]


def test_mobile_assignment_history_uses_linked_person_id_not_visible_code():
    db, current_user, worker, _ = history_context()
    duplicate = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="M.Monteur",
    )
    db.add(duplicate)
    db.commit()
    own_assignment = add_history_assignment(
        db,
        person=worker,
        site_number="linked-id",
        work_date=date(2026, 5, 12),
    )
    add_history_assignment(
        db,
        person=duplicate,
        site_number="same-visible-code",
        work_date=date(2026, 6, 29),
        end_date=date(2026, 7, 3),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [own_assignment.id]
    assert {item.person.id for item in response.assignments} == {current_user.person_id}


def test_copied_assignment_is_visible_in_mobile_history():
    db, current_user, worker, _ = history_context()
    site = Site(site_number="copy-target", name="Kopierter Einsatz", status=SiteStatus.ACTIVE)
    db.add(site)
    db.commit()

    copied = AssignmentService(db).create_assignment(
        AssignmentCreate(
            site_id=site.id,
            person_id=worker.id,
            start_date=date(2026, 4, 13),
            end_date=date(2026, 4, 17),
        ),
        user_id=current_user.id,
    ).assignment

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [copied.id]


def test_dragged_assignment_keeps_person_id_and_is_visible_in_mobile_history():
    db, current_user, worker, _ = history_context()
    source_site = Site(site_number="drag-source", name="Drag Quelle", status=SiteStatus.ACTIVE)
    target_site = Site(site_number="drag-target", name="Drag Ziel", status=SiteStatus.ACTIVE)
    db.add_all([source_site, target_site])
    db.flush()
    assignment = Assignment(
        site_id=source_site.id,
        person_id=worker.id,
        start_date=date(2026, 3, 2),
        end_date=date(2026, 3, 6),
        assignment_type=AssignmentType.REGULAR,
    )
    db.add(assignment)
    db.commit()

    moved = AssignmentService(db).update_assignment(
        assignment.id,
        AssignmentUpdate(
            site_id=target_site.id,
            start_date=date(2026, 3, 9),
            end_date=date(2026, 3, 13),
        ),
        user_id=current_user.id,
    ).assignment
    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [moved.id]
    assert response.assignments[0].person.id == worker.id
    assert response.assignments[0].site.id == target_site.id


def test_resized_assignment_range_is_visible_in_mobile_history():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="resize",
        work_date=date(2026, 2, 2),
    )

    resized = AssignmentService(db).update_assignment(
        assignment.id,
        AssignmentUpdate(end_date=date(2026, 2, 6)),
        user_id=current_user.id,
    ).assignment
    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [resized.id]
    assert response.assignments[0].start_date == date(2026, 2, 2)
    assert response.assignments[0].end_date == date(2026, 2, 6)


@pytest.mark.parametrize(
    "site_status",
    [SiteStatus.COMPLETED, SiteStatus.PAUSED, SiteStatus.DELETED],
)
def test_mobile_assignment_history_ignores_current_site_status(site_status: SiteStatus):
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number=f"status-{site_status.value}",
        work_date=date(2026, 1, 12),
        site_status=site_status,
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [assignment.id]
    assert response.assignments[0].site.status == site_status


def test_mobile_assignment_history_excludes_other_people():
    db, current_user, worker, other_worker = history_context()
    own_assignment = add_history_assignment(
        db,
        person=worker,
        site_number="1003",
        work_date=date(2026, 4, 7),
    )
    add_history_assignment(
        db,
        person=other_worker,
        site_number="1004",
        work_date=date(2026, 6, 9),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [own_assignment.id]
    assert {item.person.id for item in response.assignments} == {worker.id}


def test_mobile_assignment_history_excludes_deleted_planmatrix_assignment():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="1005",
        work_date=date(2026, 3, 2),
    )
    db.delete(assignment)
    db.commit()

    response = load_history(db, current_user)

    assert response.assignments == []


def test_mobile_assignment_history_has_no_result_limit_for_older_entries():
    db, current_user, worker, _ = history_context()
    site = Site(site_number="1006", name="Langzeittest", status=SiteStatus.ACTIVE)
    db.add(site)
    db.flush()
    first_date = date(2025, 8, 1)
    assignments = [
        Assignment(
            site_id=site.id,
            person_id=worker.id,
            start_date=first_date + timedelta(days=index * 4),
            end_date=first_date + timedelta(days=index * 4),
            assignment_type=AssignmentType.REGULAR,
        )
        for index in range(80)
    ]
    db.add_all(assignments)
    db.commit()

    response = load_history(db, current_user)

    assert len(response.assignments) == 80
    assert response.assignments[-1].id == assignments[0].id
    assert response.assignments[-1].start_date == first_date


def test_mobile_assignment_history_honors_inclusive_rolling_year_boundaries():
    db, current_user, worker, _ = history_context()
    expected = [
        add_history_assignment(
            db,
            person=worker,
            site_number="1007",
            work_date=date(2025, 7, 14),
        ),
        add_history_assignment(
            db,
            person=worker,
            site_number="1008",
            work_date=date(2026, 7, 14),
        ),
    ]
    add_history_assignment(
        db,
        person=worker,
        site_number="1009",
        work_date=date(2025, 7, 13),
    )
    add_history_assignment(
        db,
        person=worker,
        site_number="1010",
        work_date=date(2026, 7, 15),
    )

    response = load_history(db, current_user)

    assert [item.id for item in response.assignments] == [expected[1].id, expected[0].id]
    assert response.start_date == date(2025, 7, 14)
    assert response.end_date == date(2026, 7, 14)


def test_assignment_routes_use_different_range_limits_for_upcoming_and_history():
    db, current_user, worker, _ = history_context()
    assignment = add_history_assignment(
        db,
        person=worker,
        site_number="1011",
        work_date=date(2025, 8, 1),
    )

    with pytest.raises(HTTPException) as error:
        list_my_assignments(
            start=date(2025, 7, 14),
            end=date(2026, 7, 14),
            current_user=current_user,
            db=db,
        )

    response = list_my_assignment_history(
        start=date(2025, 7, 14),
        end=date(2026, 7, 14),
        current_user=current_user,
        db=db,
    )

    assert error.value.status_code == 400
    assert [item.id for item in response.assignments] == [assignment.id]


def test_mobile_assignment_sites_groups_by_site_id_and_sorts_by_latest_day():
    db, current_user, worker, _ = history_context()
    older_site = Site(site_number="old", name="Gleicher Name", status=SiteStatus.PAUSED)
    latest_site = Site(site_number="latest", name="Gleicher Name", status=SiteStatus.ACTIVE)
    db.add_all([older_site, latest_site])
    db.flush()
    db.add_all([
        Assignment(
            site_id=older_site.id,
            person_id=worker.id,
            start_date=date(2024, 12, 2),
            end_date=date(2024, 12, 4),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=latest_site.id,
            person_id=worker.id,
            start_date=date(2026, 8, 11),
            end_date=date(2026, 8, 13),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=latest_site.id,
            person_id=worker.id,
            start_date=date(2026, 8, 17),
            end_date=date(2026, 8, 18),
            assignment_type=AssignmentType.REGULAR,
        ),
    ])
    db.commit()

    response = MobileAssignmentService(db).list_own_assignment_sites(
        current_user=current_user,
        through_date=date(2026, 8, 18),
    )

    assert [item.site.id for item in response.sites] == [latest_site.id, older_site.id]
    assert [item.last_assignment_date for item in response.sites] == [date(2026, 8, 18), date(2024, 12, 4)]
    assert response.sites[0].site.status == SiteStatus.ACTIVE
    assert response.sites[1].site.status == SiteStatus.PAUSED


def test_mobile_assignment_sites_new_assignment_moves_existing_site_to_top():
    db, current_user, worker, _ = history_context()
    site_a = Site(site_number="A", name="Baustelle A", status=SiteStatus.ACTIVE)
    site_b = Site(site_number="B", name="Baustelle B", status=SiteStatus.ACTIVE)
    db.add_all([site_a, site_b])
    db.flush()
    db.add_all([
        Assignment(
            site_id=site_a.id,
            person_id=worker.id,
            start_date=date(2026, 5, 1),
            end_date=date(2026, 5, 1),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=site_b.id,
            person_id=worker.id,
            start_date=date(2026, 8, 15),
            end_date=date(2026, 8, 15),
            assignment_type=AssignmentType.REGULAR,
        ),
    ])
    db.commit()
    service = MobileAssignmentService(db)

    before = service.list_own_assignment_sites(current_user=current_user, through_date=date(2026, 8, 18))
    db.add(Assignment(
        site_id=site_a.id,
        person_id=worker.id,
        start_date=date(2026, 8, 18),
        end_date=date(2026, 8, 18),
        assignment_type=AssignmentType.REGULAR,
    ))
    db.commit()
    after = service.list_own_assignment_sites(current_user=current_user, through_date=date(2026, 8, 18))

    assert [item.site.id for item in before.sites] == [site_b.id, site_a.id]
    assert [item.site.id for item in after.sites] == [site_a.id, site_b.id]


def test_mobile_assignment_sites_only_use_signed_in_person_id_and_exclude_future():
    db, current_user, worker, other_worker = history_context()
    own = add_history_assignment(
        db,
        person=worker,
        site_number="own",
        work_date=date(2025, 1, 2),
    )
    add_history_assignment(
        db,
        person=other_worker,
        site_number="other",
        work_date=date(2026, 8, 17),
    )
    add_history_assignment(
        db,
        person=worker,
        site_number="future",
        work_date=date(2026, 8, 19),
    )

    response = MobileAssignmentService(db).list_own_assignment_sites(
        current_user=current_user,
        through_date=date(2026, 8, 18),
    )

    assert [item.site.id for item in response.sites] == [own.site_id]


def test_mobile_assignment_site_history_is_scoped_and_clips_ongoing_assignment():
    db, current_user, worker, other_worker = history_context()
    site = Site(site_number="history", name="Historie", status=SiteStatus.ACTIVE)
    other_site = Site(site_number="other-site", name="Andere", status=SiteStatus.ACTIVE)
    db.add_all([site, other_site])
    db.flush()
    own_assignments = [
        Assignment(
            site_id=site.id,
            person_id=worker.id,
            start_date=date(2026, 8, 11),
            end_date=date(2026, 8, 13),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=site.id,
            person_id=worker.id,
            start_date=date(2026, 8, 17),
            end_date=date(2026, 8, 21),
            assignment_type=AssignmentType.REGULAR,
        ),
    ]
    db.add_all(own_assignments + [
        Assignment(
            site_id=site.id,
            person_id=other_worker.id,
            start_date=date(2026, 8, 10),
            end_date=date(2026, 8, 10),
            assignment_type=AssignmentType.REGULAR,
        ),
        Assignment(
            site_id=other_site.id,
            person_id=worker.id,
            start_date=date(2026, 8, 14),
            end_date=date(2026, 8, 14),
            assignment_type=AssignmentType.REGULAR,
        ),
    ])
    db.commit()

    response = MobileAssignmentService(db).get_own_assignment_site_history(
        current_user=current_user,
        site_id=site.id,
        through_date=date(2026, 8, 18),
    )

    assert [item.id for item in response.assignments] == [own_assignments[1].id, own_assignments[0].id]
    assert response.assignments[0].end_date == date(2026, 8, 18)
    assert {item.person.id for item in response.assignments} == {worker.id}
    assert {item.site.id for item in response.assignments} == {site.id}


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
