from datetime import date

from app.models.assignment import Assignment
from app.models.enums import AssignmentType, PersonType
from app.models.person import Person
from app.services.mobile_assignment_service import MobileAssignmentService
from app.schemas.mobile import MobileSelfPlanRequest
from app.tests.test_mobile_assignment_service import history_context, add_history_assignment


def test_upcoming_team_includes_internal_and_external_workers_only_during_own_overlap():
    db, user, worker, colleague = history_context()
    own = add_history_assignment(db, person=worker, site_number="1001", work_date=date(2026, 9, 21), end_date=date(2026, 9, 25))
    external = Person(first_name="Jan", last_name="Tietz", display_name="Jan Tietz", short_code="JT", person_type=PersonType.EXTERNAL)
    temp = Person(first_name="Jens", last_name="Koehle", display_name="Jens Koehle", short_code="JK", person_type=PersonType.EXTERNAL_TEMP)
    db.add_all([external, temp]); db.flush()

    def plan(person, start, end):
        db.add(Assignment(site_id=own.site_id, person_id=person.id, start_date=date(2026, 9, start), end_date=date(2026, 9, end), assignment_type=AssignmentType.REGULAR))

    plan(colleague, 18, 23)
    plan(colleague, 18, 23)  # Duplicate planning must not duplicate the colleague.
    plan(external, 24, 24)
    plan(temp, 25, 28)
    plan(colleague, 28, 29)  # Same site, but not while the current worker is there.
    add_history_assignment(db, person=external, site_number="1002", work_date=date(2026, 9, 21))
    db.commit()
    result = MobileAssignmentService(db).list_own_assignments(current_user=user, start=date(2026, 9, 21), end=date(2026, 10, 2))
    assert [item.id for item in result.assignments] == [own.id]
    peers = result.assignments[0].colleagues
    assert len(peers) == 3
    assert {(p.person_id, p.start_date, p.end_date) for p in peers} == {
        (colleague.id, date(2026, 9, 21), date(2026, 9, 23)),
        (external.id, date(2026, 9, 24), date(2026, 9, 24)),
        (temp.id, date(2026, 9, 25), date(2026, 9, 25)),
    }
    assert all(set(p.model_dump()) == {"person_id", "last_name", "start_date", "end_date"} for p in peers)


def test_team_is_clipped_to_request_and_missing_colleagues_is_an_empty_list():
    db, user, worker, colleague = history_context()
    own = add_history_assignment(db, person=worker, site_number="1001", work_date=date(2026, 9, 21), end_date=date(2026, 9, 25))
    service = MobileAssignmentService(db)
    result = service.list_own_assignments(current_user=user, start=date(2026, 9, 22), end=date(2026, 9, 24))
    assert result.assignments[0].colleagues == []
    db.add(Assignment(site_id=own.site_id, person_id=colleague.id, start_date=date(2026, 9, 20), end_date=date(2026, 9, 26), assignment_type=AssignmentType.REGULAR))
    db.commit()
    result = service.list_own_assignments(current_user=user, start=date(2026, 9, 22), end=date(2026, 9, 24))
    assert [(p.start_date, p.end_date) for p in result.assignments[0].colleagues] == [(date(2026, 9, 22), date(2026, 9, 24))]


def test_self_plan_response_includes_colleagues_without_an_extra_client_refresh(monkeypatch):
    db, user, worker, colleague = history_context()
    own = add_history_assignment(db, person=worker, site_number="1001", work_date=date(2026, 9, 21))
    db.add(Assignment(site_id=own.site_id, person_id=colleague.id, start_date=date(2026, 9, 21), end_date=date(2026, 9, 21), assignment_type=AssignmentType.REGULAR))
    db.commit()
    service = MobileAssignmentService(db)
    monkeypatch.setattr(service, "_is_known_site_for_mobile", lambda **kwargs: True)
    response = service.self_plan_assignment(current_user=user, payload=MobileSelfPlanRequest(site_id=own.site_id, work_date=date(2026, 9, 21)))
    assert [peer.person_id for peer in response.colleagues] == [colleague.id]
