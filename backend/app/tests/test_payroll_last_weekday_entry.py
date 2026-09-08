from datetime import date
from types import SimpleNamespace

import pytest

from app.models.enums import AbsenceStatus
from app.services.payroll_month_close_service import PayrollMonthCloseService


def source(*, entries=(), absences=()):
    return SimpleNamespace(
        people=(SimpleNamespace(id=1),), entries=entries, absences=absences,
    )


@pytest.mark.parametrize(("month_end", "last_weekday"), [
    (date(2026, 8, 31), date(2026, 8, 31)),
    (date(2026, 9, 30), date(2026, 9, 30)),
    (date(2026, 10, 31), date(2026, 10, 30)),
    (date(2027, 1, 31), date(2027, 1, 29)),
    (date(2028, 2, 29), date(2028, 2, 29)),
])
def test_empty_month_requires_entry_on_last_monday_to_friday(month_end, last_weekday):
    blockers = PayrollMonthCloseService._last_weekday_entry_blockers(source(), month_end)
    assert [(item.code, item.person_id, item.work_date) for item in blockers] == [
        ("payroll_last_weekday_entry_missing", 1, last_weekday),
    ]


@pytest.mark.parametrize(("person_id", "work_date", "missing"), [
    (1, date(2026, 10, 30), False),
    (1, date(2026, 10, 29), True),
    (1, date(2026, 10, 31), True),
    (1, date(2026, 11, 30), True),
    (2, date(2026, 10, 30), True),
])
def test_only_entry_of_same_person_on_last_weekday_counts(person_id, work_date, missing):
    entries = (SimpleNamespace(person_id=person_id, work_date=work_date),)
    assert bool(PayrollMonthCloseService._last_weekday_entry_blockers(
        source(entries=entries), date(2026, 10, 31),
    )) is missing


@pytest.mark.parametrize(("person_id", "start", "end", "active", "missing"), [
    (1, 28, 30, True, False),
    (1, 30, 30, True, False),
    (1, 28, 29, True, True),
    (1, 31, 31, True, True),
    (1, 28, 30, False, True),
    (2, 28, 30, True, True),
])
def test_active_absence_covering_last_weekday_counts(person_id, start, end, active, missing):
    absences = (SimpleNamespace(
        person_id=person_id, start_date=date(2026, 10, start),
        end_date=date(2026, 10, end),
        status=AbsenceStatus.ACTIVE if active else "cancelled",
    ),)
    assert bool(PayrollMonthCloseService._last_weekday_entry_blockers(
        source(absences=absences), date(2026, 10, 31),
    )) is missing


def test_week_approval_does_not_replace_missing_entry():
    blocker = PayrollMonthCloseService._last_weekday_entry_blockers(
        source(), date(2026, 9, 30),
    )[0]
    assert not PayrollMonthCloseService._covered_by_reviews(
        blocker, {(1, 2026, 40)}, {(1, date(2026, 9, 30))},
    )
