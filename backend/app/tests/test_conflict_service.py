from datetime import date
from types import SimpleNamespace

from app.models.enums import AbsenceStatus, AbsenceType, SiteStatus
from app.services.conflict_service import ConflictService


class FakePeople:
    def __init__(self, person):
        self.person = person

    def get(self, person_id):
        return self.person if self.person and self.person.id == person_id else None


class FakeSites:
    def __init__(self, site):
        self.site = site

    def get(self, site_id):
        return self.site if self.site and self.site.id == site_id else None


class FakeAssignments:
    def __init__(self, assignments):
        self.assignments = assignments

    def list(self, *, start=None, end=None, person_id=None, site_id=None):
        return [
            assignment
            for assignment in self.assignments
            if (person_id is None or assignment.person_id == person_id)
            and (start is None or end is None or assignment.start_date <= end)
            and (start is None or end is None or assignment.end_date >= start)
        ]


class FakeAbsences:
    def __init__(self, absences):
        self.absences = absences

    def list(self, *, start=None, end=None, person_id=None):
        return [
            absence
            for absence in self.absences
            if (person_id is None or absence.person_id == person_id)
            and (start is None or end is None or absence.start_date <= end)
            and (start is None or end is None or absence.end_date >= start)
            and absence.status == AbsenceStatus.ACTIVE
        ]


def service_with(person=None, site=None, assignments=None, absences=None):
    service = ConflictService.__new__(ConflictService)
    service.people = FakePeople(person)
    service.sites = FakeSites(site)
    service.assignments = FakeAssignments(assignments or [])
    service.absences = FakeAbsences(absences or [])
    return service


def person(is_active=True):
    return SimpleNamespace(id=1, is_active=is_active)


def site(status=SiteStatus.ACTIVE):
    return SimpleNamespace(id=1, status=status)


def assignment(assignment_id, start, end):
    return SimpleNamespace(
        id=assignment_id,
        person_id=1,
        start_date=start,
        end_date=end,
    )


def absence(absence_type, start, end):
    return SimpleNamespace(
        person_id=1,
        absence_type=absence_type,
        start_date=start,
        end_date=end,
        status=AbsenceStatus.ACTIVE,
    )


def test_second_assignment_returns_info():
    check = service_with(
        person=person(),
        site=site(),
        assignments=[assignment(1, date(2027, 1, 4), date(2027, 1, 4))],
    ).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
    )

    assert not check.blockers
    assert check.infos[0].code == "second_assignment_same_day"


def test_third_assignment_is_blocked():
    check = service_with(
        person=person(),
        site=site(),
        assignments=[
            assignment(1, date(2027, 1, 4), date(2027, 1, 4)),
            assignment(2, date(2027, 1, 4), date(2027, 1, 4)),
        ],
    ).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
    )

    assert check.blockers[0].code == "too_many_assignments"


def test_vacation_blocks_assignment():
    check = service_with(
        person=person(),
        site=site(),
        absences=[absence(AbsenceType.VACATION, date(2027, 1, 4), date(2027, 1, 5))],
    ).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 5),
        end_date=date(2027, 1, 5),
    )

    assert check.blockers[0].code == "absence_vacation"


def test_school_returns_warning():
    check = service_with(
        person=person(),
        site=site(),
        absences=[absence(AbsenceType.SCHOOL, date(2027, 1, 4), date(2027, 1, 4))],
    ).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
    )

    assert not check.blockers
    assert check.warnings[0].code == "absence_school"


def test_completed_site_is_blocked():
    check = service_with(person=person(), site=site(SiteStatus.COMPLETED)).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
    )

    assert check.blockers[0].code == "site_completed_or_deleted"


def test_inactive_person_is_blocked():
    check = service_with(person=person(is_active=False), site=site()).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
    )

    assert check.blockers[0].code == "person_inactive"


def test_updating_assignment_excludes_itself():
    check = service_with(
        person=person(),
        site=site(),
        assignments=[assignment(7, date(2027, 1, 4), date(2027, 1, 4))],
    ).check_assignment(
        person_id=1,
        site_id=1,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 4),
        exclude_assignment_id=7,
    )

    assert not check.blockers
    assert not check.infos
