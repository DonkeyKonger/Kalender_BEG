from datetime import date, time
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_export_service import (
    PayrollMonthExportService,
    lower_saxony_public_holiday_dates,
    payroll_month_source_range,
)


def test_all_workers_export_uses_active_payroll_workers_and_one_master_sheet_each():
    db = database()
    anna = person(1, "Anna", "Bau")
    bernd = person(2, "Bernd", "Strom")
    office = person(3, "Olivia", "Büro")
    db.add_all(
        [
            anna,
            bernd,
            office,
            user(1, "bernd", UserRole.MONTEUR, bernd),
            user(2, "office", UserRole.OFFICE, office),
        ]
    )
    site = Site(id=1, site_number="4711", name="Rathaus", address="Markt 1")
    db.add(site)
    db.add_all(
        [
            entry(1, anna.id, site.id, date(2026, 8, 3)),
            entry(2, bernd.id, site.id, date(2026, 8, 4)),
            entry(3, office.id, site.id, date(2026, 8, 5)),
        ]
    )
    db.commit()

    content = PayrollMonthExportService(db).all_workers_export(
        year=2026,
        month=8,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
    )

    with ZipFile(BytesIO(content)) as workbook:
        workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
        assert workbook.testzip() is None
        assert "xl/worksheets/sheet2.xml" in workbook.namelist()
        assert "xl/worksheets/sheet3.xml" not in workbook.namelist()
        assert 'name="Bau"' in workbook_xml
        assert 'name="Strom"' in workbook_xml
        assert "Büro" not in workbook_xml


def test_single_worker_export_uses_boundary_week_entries_and_dynamic_sheet_name():
    db = database()
    worker = person(1, "Anna", "Bau")
    site = Site(id=1, site_number="4711", name="Rathaus", address="Markt 1")
    db.add_all([worker, site, entry(1, worker.id, site.id, date(2026, 8, 3))])
    db.commit()

    content = PayrollMonthExportService(db).worker_export(
        person_id=worker.id,
        year=2026,
        month=8,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
    )

    with ZipFile(BytesIO(content)) as workbook:
        assert workbook.testzip() is None
        assert 'name="Bau"' in workbook.read("xl/workbook.xml").decode("utf-8")
        assert b"4711" in workbook.read("xl/worksheets/sheet1.xml")


def test_month_source_range_and_lower_saxony_holidays_cover_boundary_weeks():
    period_start, period_end = payroll_month_source_range(2026, 8)

    assert period_start == date(2026, 7, 27)
    assert period_end == date(2026, 9, 6)
    assert lower_saxony_public_holiday_dates(
        date(2026, 4, 1), date(2026, 4, 30)
    ) == {date(2026, 4, 3), date(2026, 4, 6)}


def database() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def person(person_id: int, first_name: str, last_name: str) -> Person:
    return Person(
        id=person_id,
        first_name=first_name,
        last_name=last_name,
        display_name=f"{first_name} {last_name}",
        short_code=f"{first_name[0]}{last_name[0]}",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )


def user(user_id: int, username: str, role: UserRole, linked_person: Person) -> User:
    return User(
        id=user_id,
        username=username,
        display_name=linked_person.display_name,
        password_hash="test",
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
        person=linked_person,
    )


def entry(entry_id: int, person_id: int, site_id: int, work_date: date) -> WorkTimeEntry:
    return WorkTimeEntry(
        id=entry_id,
        person_id=person_id,
        site_id=site_id,
        work_date=work_date,
        start_time=time(6, 0),
        end_time=time(15, 0),
        break_minutes=30,
        travel_minutes=0,
        work_minutes=510,
        source="manual",
        status="submitted",
        time_review_status="manually_approved",
    )
