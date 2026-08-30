from datetime import date, time
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import (
    AbsenceStatus,
    AbsenceType,
    AssignmentType,
    PersonType,
    SiteStatus,
)
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBase, SiteMeasurementItem
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_site_cockpit_service import (
    FORECAST_UNAVAILABLE_REASON,
    OFFER_BUDGET_BASIS,
    PayrollSiteCockpitService,
)


TEST_TODAY = date(2026, 8, 31)


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def cockpit_service(
    db: Session,
    *,
    today: date = TEST_TODAY,
) -> PayrollSiteCockpitService:
    return PayrollSiteCockpitService(db, today_provider=lambda: today)


def person(code: str, *, person_type: PersonType = PersonType.INTERNAL) -> Person:
    return Person(
        first_name=code,
        last_name="Test",
        display_name=f"{code} Test",
        short_code=code,
        person_type=person_type,
    )


def time_entry(
    *,
    person_id: int,
    site_id: int,
    work_date: date,
    work_minutes: int,
    payroll_corrected_work_minutes: int | None = None,
    source: str = "manual",
) -> WorkTimeEntry:
    return WorkTimeEntry(
        person_id=person_id,
        site_id=site_id,
        work_date=work_date,
        work_minutes=work_minutes,
        payroll_corrected_work_minutes=payroll_corrected_work_minutes,
        break_minutes=0,
        travel_minutes=0,
        source=source,
    )


def measurement_base(
    *,
    site_id: int,
    name: str,
    status: str = "active",
    released_to_mobile: bool = True,
) -> SiteMeasurementBase:
    return SiteMeasurementBase(
        site_id=site_id,
        name=name,
        status=status,
        released_to_mobile=released_to_mobile,
    )


def measurement_item(
    *,
    site_id: int,
    base_id: int,
    position: str,
    quantity: str,
    minutes_per_unit: str,
    hidden: bool = False,
) -> SiteMeasurementItem:
    return SiteMeasurementItem(
        site_id=site_id,
        measurement_base_id=base_id,
        position=position,
        description=position,
        list_quantity=Decimal(quantity),
        minutes_per_unit=Decimal(minutes_per_unit),
        is_hidden=hidden,
        sort_order=1,
    )


def test_cockpit_uses_real_offer_and_project_mounting_semantics() -> None:
    db = db_session()
    internal = person("IN")
    external = person("EX", person_type=PersonType.EXTERNAL)
    absent_external = person("AB", person_type=PersonType.EXTERNAL_TEMP)
    critical_site = Site(
        site_number="1001",
        name="Kritische Baustelle",
        status=SiteStatus.ACTIVE,
    )
    missing_site = Site(
        site_number="1002",
        name="Ohne Angebotsbasis",
        status=SiteStatus.ACTIVE,
    )
    old_only_site = Site(
        site_number="1003",
        name="Nicht im Monat",
        status=SiteStatus.ACTIVE,
    )
    db.add_all(
        [internal, external, absent_external, critical_site, missing_site, old_only_site]
    )
    db.flush()

    work_day = date(2026, 8, 12)
    db.add_all(
        [
            time_entry(
                person_id=internal.id,
                site_id=critical_site.id,
                work_date=date(2026, 7, 20),
                work_minutes=300,
            ),
            time_entry(
                person_id=internal.id,
                site_id=critical_site.id,
                work_date=work_day,
                work_minutes=240,
                payroll_corrected_work_minutes=360,
            ),
            time_entry(
                person_id=internal.id,
                site_id=missing_site.id,
                work_date=date(2026, 8, 13),
                work_minutes=120,
            ),
            time_entry(
                person_id=internal.id,
                site_id=old_only_site.id,
                work_date=date(2026, 7, 15),
                work_minutes=90,
            ),
            time_entry(
                person_id=internal.id,
                site_id=old_only_site.id,
                work_date=date(2026, 8, 14),
                work_minutes=999,
                source="gps_suggestion",
            ),
            Assignment(
                site_id=critical_site.id,
                person_id=external.id,
                start_date=work_day,
                end_date=work_day,
                assignment_type=AssignmentType.REGULAR,
            ),
            Assignment(
                site_id=critical_site.id,
                person_id=absent_external.id,
                start_date=work_day,
                end_date=work_day,
                assignment_type=AssignmentType.REGULAR,
            ),
            Absence(
                person_id=absent_external.id,
                absence_type=AbsenceType.SICK,
                start_date=work_day,
                end_date=work_day,
                status=AbsenceStatus.ACTIVE,
            ),
        ]
    )

    old_base = measurement_base(site_id=critical_site.id, name="Alt")
    db.add(old_base)
    db.flush()
    db.add(
        measurement_item(
            site_id=critical_site.id,
            base_id=old_base.id,
            position="ALT",
            quantity="100",
            minutes_per_unit="100",
        )
    )
    active_base = measurement_base(site_id=critical_site.id, name="Aktuell")
    inactive_base = measurement_base(
        site_id=critical_site.id,
        name="Nicht aktiv",
        status="archived",
    )
    unreleased_base = measurement_base(
        site_id=critical_site.id,
        name="Nicht freigegeben",
        released_to_mobile=False,
    )
    db.add_all([active_base, inactive_base, unreleased_base])
    db.flush()
    db.add_all(
        [
            measurement_item(
                site_id=critical_site.id,
                base_id=active_base.id,
                position="A",
                quantity="100",
                minutes_per_unit="6",
            ),
            measurement_item(
                site_id=critical_site.id,
                base_id=active_base.id,
                position="VERDECKT",
                quantity="10",
                minutes_per_unit="50",
                hidden=True,
            ),
            measurement_item(
                site_id=critical_site.id,
                base_id=inactive_base.id,
                position="INAKTIV",
                quantity="10",
                minutes_per_unit="80",
            ),
            measurement_item(
                site_id=critical_site.id,
                base_id=unreleased_base.id,
                position="NICHT-FREIGEGEBEN",
                quantity="10",
                minutes_per_unit="90",
            ),
        ]
    )
    db.commit()

    result = cockpit_service(db).get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    )

    assert result.date_from == date(2026, 8, 1)
    assert result.date_to == date(2026, 8, 31)
    assert result.effective_as_of == date(2026, 8, 31)
    assert result.offer_budget_basis == OFFER_BUDGET_BASIS
    assert result.offer_budget_as_of == TEST_TODAY
    assert [site.site_id for site in result.sites] == [critical_site.id, missing_site.id]

    critical = result.sites[0]
    assert critical.offer_minutes == 600
    assert critical.actual_minutes == 1020
    assert critical.variance_minutes == 420
    assert critical.utilization_percent == 170
    assert critical.risk_level == "critical"
    assert critical.forecast_minutes is None
    assert critical.forecast_reason == FORECAST_UNAVAILABLE_REASON

    missing = result.sites[1]
    assert missing.offer_minutes is None
    assert missing.actual_minutes == 120
    assert missing.risk_level == "missing_data"

    assert result.totals.offer_minutes == 600
    assert result.totals.actual_minutes == 1140
    assert result.totals.forecast_minutes is None
    assert result.totals.forecast_reason == FORECAST_UNAVAILABLE_REASON
    assert result.totals.variance_minutes is None
    assert result.totals.site_count == 2
    assert result.totals.budget_site_count == 1
    assert result.totals.forecast_site_count == 0
    assert [item.risk_level for item in result.action_items] == [
        "critical",
        "missing_data",
    ]
    assert [item.rank for item in result.action_items] == [1, 2]


@pytest.mark.parametrize(
    ("offer_minutes", "actual_minutes", "expected"),
    [
        (None, 10, "missing_data"),
        (1000, 849, "none"),
        (1000, 850, "warning"),
        (1000, 1000, "warning"),
        (1000, 1001, "critical"),
    ],
)
def test_risk_thresholds(
    offer_minutes: float | None,
    actual_minutes: int,
    expected: str,
) -> None:
    utilization = (
        actual_minutes / offer_minutes * 100
        if offer_minutes is not None and offer_minutes > 0
        else None
    )

    risk, _reason = PayrollSiteCockpitService._risk(
        offer_minutes=offer_minutes,
        actual_minutes=actual_minutes,
        utilization_percent=utilization,
    )

    assert risk == expected


def test_history_is_cumulative_and_ends_at_effective_date() -> None:
    db = db_session()
    worker = person("MO")
    external = person("EX", person_type=PersonType.EXTERNAL)
    site = Site(site_number="2001", name="Verlauf", status=SiteStatus.ACTIVE)
    db.add_all([worker, external, site])
    db.flush()
    second_day = date(2026, 8, 4)
    db.add_all(
        [
            time_entry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 3),
                work_minutes=300,
            ),
            time_entry(
                person_id=worker.id,
                site_id=site.id,
                work_date=second_day,
                work_minutes=200,
                payroll_corrected_work_minutes=450,
            ),
            Assignment(
                site_id=site.id,
                person_id=external.id,
                start_date=second_day,
                end_date=second_day,
                assignment_type=AssignmentType.REGULAR,
            ),
        ]
    )
    base = measurement_base(site_id=site.id, name="Angebot")
    db.add(base)
    db.flush()
    db.add(
        measurement_item(
            site_id=site.id,
            base_id=base.id,
            position="A",
            quantity="100",
            minutes_per_unit="6",
        )
    )
    db.commit()

    result = cockpit_service(db).get_history(
        site_id=site.id,
        date_to=date(2026, 8, 31),
    )

    assert result.date_from == date(2026, 8, 3)
    assert result.date_to == date(2026, 8, 31)
    assert result.effective_as_of == date(2026, 8, 31)
    assert result.offer_budget_basis == OFFER_BUDGET_BASIS
    assert result.offer_budget_as_of == TEST_TODAY
    assert result.offer_minutes == 600
    assert [(point.date, point.actual_minutes) for point in result.points] == [
        (date(2026, 8, 3), 300),
        (date(2026, 8, 4), 1200),
        (date(2026, 8, 31), 1200),
    ]
    assert all(point.forecast_minutes is None for point in result.points)
    assert result.forecast_reason == FORECAST_UNAVAILABLE_REASON


def test_future_dates_are_excluded_from_portfolio_actuals_and_history() -> None:
    db = db_session()
    worker = person("FU")
    active_site = Site(site_number="3001", name="Bis heute", status=SiteStatus.ACTIVE)
    future_only_site = Site(
        site_number="3002",
        name="Nur Zukunft",
        status=SiteStatus.ACTIVE,
    )
    db.add_all([worker, active_site, future_only_site])
    db.flush()
    db.add_all(
        [
            time_entry(
                person_id=worker.id,
                site_id=active_site.id,
                work_date=date(2026, 8, 10),
                work_minutes=60,
            ),
            time_entry(
                person_id=worker.id,
                site_id=active_site.id,
                work_date=date(2026, 8, 20),
                work_minutes=600,
            ),
            time_entry(
                person_id=worker.id,
                site_id=future_only_site.id,
                work_date=date(2026, 8, 21),
                work_minutes=900,
            ),
        ]
    )
    db.commit()
    service = cockpit_service(db, today=date(2026, 8, 15))

    cockpit = service.get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    )
    history = service.get_history(
        site_id=active_site.id,
        date_to=date(2026, 8, 31),
    )
    future_month = service.get_cockpit(
        date_from=date(2026, 9, 1),
        date_to=date(2026, 9, 30),
    )

    assert cockpit.effective_as_of == date(2026, 8, 15)
    assert cockpit.offer_budget_as_of == date(2026, 8, 15)
    assert [site.site_id for site in cockpit.sites] == [active_site.id]
    assert cockpit.totals.actual_minutes == 60
    assert history.effective_as_of == date(2026, 8, 15)
    assert [(point.date, point.actual_minutes) for point in history.points] == [
        (date(2026, 8, 10), 60),
        (date(2026, 8, 15), 60),
    ]
    assert all(point.date <= history.effective_as_of for point in history.points)
    assert future_month.effective_as_of == date(2026, 8, 15)
    assert future_month.totals.actual_minutes == 0
    assert future_month.sites == []


def test_historical_actual_cutoff_uses_current_offer_budget_basis() -> None:
    db = db_session()
    worker = person("HB")
    site = Site(site_number="4001", name="Historisches Ist", status=SiteStatus.ACTIVE)
    db.add_all([worker, site])
    db.flush()
    db.add(
        time_entry(
            person_id=worker.id,
            site_id=site.id,
            work_date=date(2026, 7, 15),
            work_minutes=300,
        )
    )
    old_base = measurement_base(site_id=site.id, name="Historisches Angebot", status="archived")
    current_base = measurement_base(site_id=site.id, name="Aktuelle Angebotsbasis")
    db.add_all([old_base, current_base])
    db.flush()
    db.add_all(
        [
            measurement_item(
                site_id=site.id,
                base_id=old_base.id,
                position="ALT",
                quantity="100",
                minutes_per_unit="6",
            ),
            measurement_item(
                site_id=site.id,
                base_id=current_base.id,
                position="AKTUELL",
                quantity="100",
                minutes_per_unit="9",
            ),
        ]
    )
    db.commit()
    service = cockpit_service(db, today=date(2026, 9, 10))

    result = service.get_cockpit(
        date_from=date(2026, 7, 1),
        date_to=date(2026, 7, 31),
    )

    assert result.effective_as_of == date(2026, 7, 31)
    assert result.offer_budget_as_of == date(2026, 9, 10)
    assert result.offer_budget_basis == "current_active_released_measurement_base"
    assert result.sites[0].offer_minutes == 900


def test_column_aggregation_matches_payroll_range_fallback_semantics() -> None:
    db = db_session()
    worker = person("PR")
    site = Site(site_number="5001", name="Korrekturregeln", status=SiteStatus.ACTIVE)
    db.add_all([worker, site])
    db.flush()
    db.add_all(
        [
            WorkTimeEntry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 1),
                work_minutes=10,
                payroll_corrected_start_time=time(22, 0),
                payroll_corrected_end_time=time(2, 0),
                payroll_corrected_break_minutes=30,
                break_minutes=0,
                travel_minutes=0,
            ),
            WorkTimeEntry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 2),
                work_minutes=200,
                corrected_work_minutes=90,
                payroll_corrected_start_time=time(8, 0),
                payroll_corrected_end_time=time(8, 0),
                break_minutes=0,
                travel_minutes=0,
            ),
            WorkTimeEntry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 3),
                work_minutes=200,
                corrected_work_minutes=75,
                payroll_corrected_start_time=time(8, 0),
                payroll_corrected_end_time=time(9, 0),
                payroll_corrected_break_minutes=90,
                break_minutes=0,
                travel_minutes=0,
            ),
            WorkTimeEntry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 4),
                work_minutes=500,
                payroll_corrected_work_minutes=0,
                break_minutes=0,
                travel_minutes=0,
            ),
        ]
    )
    db.commit()

    result = cockpit_service(db).get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    )

    assert result.totals.actual_minutes == 375
    assert result.sites[0].actual_minutes == 375


def test_service_rejects_invalid_range_and_unknown_site() -> None:
    db = db_session()
    service = cockpit_service(db)

    with pytest.raises(HTTPException) as range_error:
        service.get_cockpit(
            date_from=date(2026, 8, 31),
            date_to=date(2026, 8, 1),
        )
    assert range_error.value.status_code == 400

    with pytest.raises(HTTPException) as month_error:
        service.get_cockpit(
            date_from=date(2026, 8, 31),
            date_to=date(2026, 9, 1),
        )
    assert month_error.value.status_code == 400
    assert "selben Kalendermonat" in month_error.value.detail

    with pytest.raises(HTTPException) as site_error:
        service.get_history(site_id=999, date_to=date(2026, 8, 31))
    assert site_error.value.status_code == 404


def _query_count_for_site_count(site_count: int) -> tuple[int, list[str]]:
    db = db_session()
    worker = person(f"IN{site_count}")
    db.add(worker)
    db.flush()
    for index in range(site_count):
        site = Site(
            site_number=f"Q-{site_count}-{index}",
            name=f"Query {index}",
            status=SiteStatus.ACTIVE,
        )
        db.add(site)
        db.flush()
        db.add(
            time_entry(
                person_id=worker.id,
                site_id=site.id,
                work_date=date(2026, 8, 10),
                work_minutes=60,
            )
        )
        base = measurement_base(site_id=site.id, name="Angebot")
        db.add(base)
        db.flush()
        db.add(
            measurement_item(
                site_id=site.id,
                base_id=base.id,
                position="A",
                quantity="10",
                minutes_per_unit="10",
            )
        )
    db.commit()

    statements: list[str] = []

    def collect_query(
        _connection,
        _cursor,
        statement: str,
        _parameters,
        _context,
        _executemany,
    ) -> None:
        statements.append(statement)

    engine = db.get_bind()
    assert isinstance(engine, Engine)
    event.listen(engine, "before_cursor_execute", collect_query)
    try:
        cockpit_service(db).get_cockpit(
            date_from=date(2026, 8, 1),
            date_to=date(2026, 8, 31),
        )
    finally:
        event.remove(engine, "before_cursor_execute", collect_query)
        db.close()
    return len(statements), statements


def test_cockpit_query_count_is_constant_and_does_not_touch_gps_tables() -> None:
    one_site_count, one_site_statements = _query_count_for_site_count(1)
    three_site_count, three_site_statements = _query_count_for_site_count(3)

    assert three_site_count == one_site_count
    assert all("gps" not in statement.casefold() for statement in one_site_statements)
    assert all("gps" not in statement.casefold() for statement in three_site_statements)
    assert any("select distinct" in statement.casefold() for statement in one_site_statements)
    work_entry_selects = [
        statement
        for statement in one_site_statements
        if "from work_time_entries" in statement.casefold()
    ]
    assert work_entry_selects
    assert all("travel_minutes" not in statement for statement in work_entry_selects)
    assert all("work_time_entries.note" not in statement for statement in work_entry_selects)
