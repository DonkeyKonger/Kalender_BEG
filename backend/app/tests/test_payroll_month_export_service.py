import xml.etree.ElementTree as ET
from datetime import date, time
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

import pytest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, OvernightStatus, PersonType, UserRole
from app.models.person import Person
from app.models.person_work_day import PersonWorkDay
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
    anna.weekly_hours = 40
    bernd.weekly_hours = 30
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
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        for index, normal_hours in ((1, 168), (2, 126)):
            sheet = ET.fromstring(workbook.read(f"xl/worksheets/sheet{index}.xml"))
            assert float(sheet.find('.//m:c[@r="D46"]/m:v', ns).text) == pytest.approx(
                normal_hours / 24
            )


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


def test_single_worker_export_excludes_configured_public_holidays_from_normal_hours():
    db = database()
    worker = person(1, "Anna", "Bau")
    worker.weekly_hours = 40
    db.add(worker)
    db.commit()
    content = PayrollMonthExportService(db).worker_export(
        person_id=worker.id, year=2026, month=4,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
    )
    with ZipFile(BytesIO(content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    assert float(sheet.find('.//m:c[@r="D46"]/m:v', ns).text) == pytest.approx(160 / 24)


@pytest.mark.parametrize("all_workers", [False, True])
def test_downloads_load_calendar_absences_even_without_time_entries(all_workers):
    db = database()
    anna = person(1, "Anna", "Bau")
    bernd = person(2, "Bernd", "Strom")
    anna.weekly_hours = bernd.weekly_hours = 40
    db.add_all([anna, bernd])
    db.flush()
    db.add_all([
        Absence(
            person_id=anna.id, absence_type=AbsenceType.VACATION,
            start_date=date(2026, 4, 2), end_date=date(2026, 4, 7),
            status=AbsenceStatus.ACTIVE,
        ),
        Absence(
            person_id=anna.id, absence_type=AbsenceType.SICK,
            start_date=date(2026, 4, 8), end_date=date(2026, 4, 8),
            status=AbsenceStatus.ACTIVE,
        ),
        Absence(
            person_id=anna.id, absence_type=AbsenceType.VACATION,
            start_date=date(2026, 4, 9), end_date=date(2026, 4, 9),
            status=AbsenceStatus.CANCELLED,
        ),
        Absence(
            person_id=bernd.id, absence_type=AbsenceType.VACATION,
            start_date=date(2026, 4, 9), end_date=date(2026, 4, 9),
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()
    service = PayrollMonthExportService(db)
    args = dict(year=2026, month=4, current_user=SimpleNamespace(role=UserRole.ADMIN))
    content = (
        service.all_workers_export(**args) if all_workers
        else service.worker_export(person_id=anna.id, **args)
    )
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with ZipFile(BytesIO(content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        assert float(sheet.find('.//m:c[@r="E41"]/m:v', ns).text) * 24 == pytest.approx(16)
        assert sheet.find('.//m:c[@r="H11"]/m:is/m:t', ns).text == "Urlaub"
        assert sheet.find('.//m:c[@r="H16"]/m:is/m:t', ns).text == "Urlaub"
        assert sheet.find('.//m:c[@r="H17"]/m:is/m:t', ns).text == "Krankheit"
        assert float(sheet.find('.//m:c[@r="E17"]/m:v', ns).text) == 0
        assert sheet.find('.//m:c[@r="D48"]/m:v', ns).text == "1"
        assert float(sheet.find('.//m:c[@r="G48"]/m:v', ns).text) * 24 == pytest.approx(8)
        assert float(sheet.find('.//m:c[@r="D46"]/m:v', ns).text) * 24 == pytest.approx(152)
        for row in (12, 13, 14, 15, 18):  # Feiertage, Wochenende, stornierter Urlaub.
            assert len(sheet.find(f'.//m:c[@r="E{row}"]', ns)) == 0
            assert len(sheet.find(f'.//m:c[@r="H{row}"]', ns)) == 0
        if all_workers:
            second = ET.fromstring(workbook.read("xl/worksheets/sheet2.xml"))
            assert float(second.find('.//m:c[@r="E41"]/m:v', ns).text) * 24 == pytest.approx(8)
            assert second.find('.//m:c[@r="H18"]/m:is/m:t', ns).text == "Urlaub"
            assert second.find('.//m:c[@r="D48"]/m:v', ns).text == "0"
            assert float(second.find('.//m:c[@r="G48"]/m:v', ns).text) == 0
            assert float(second.find('.//m:c[@r="D46"]/m:v', ns).text) * 24 == pytest.approx(160)
        else:
            assert "xl/worksheets/sheet2.xml" not in workbook.namelist()


def test_downloads_share_expense_rules_and_load_overnight_only_boundary_days():
    db = database()
    anna = person(1, "Anna", "Bau")
    bernd = person(2, "Bernd", "Strom")
    site = Site(id=1, site_number="4711", name="Rathaus")
    db.add_all([anna, bernd, site])
    db.flush()
    db.add_all([
        entry(1, anna.id, site.id, date(2026, 6, 1)),
        entry(2, anna.id, site.id, date(2026, 6, 3)),
        entry(3, bernd.id, site.id, date(2026, 6, 1)),
        PersonWorkDay(person_id=anna.id, work_date=date(2026, 5, 31),
                      overnight_status=OvernightStatus.BEG_PAID),
        PersonWorkDay(person_id=anna.id, work_date=date(2026, 6, 1),
                      overnight_status=OvernightStatus.SELF_PAID),
        PersonWorkDay(person_id=anna.id, work_date=date(2026, 6, 2),
                      overnight_status=OvernightStatus.BEG_PAID),
        PersonWorkDay(person_id=anna.id, work_date=date(2026, 6, 3),
                      overnight_status=OvernightStatus.NONE),
        PersonWorkDay(person_id=anna.id, work_date=date(2026, 6, 5),
                      overnight_status=OvernightStatus.NONE),
        PersonWorkDay(person_id=bernd.id, work_date=date(2026, 6, 1),
                      overnight_status=OvernightStatus.NONE),
    ])
    db.commit()
    service = PayrollMonthExportService(db)
    args = dict(year=2026, month=6, current_user=SimpleNamespace(role=UserRole.ADMIN))
    single = service.worker_export(person_id=anna.id, **args)
    multiple = service.all_workers_export(**args)
    repeated = service.worker_export(person_id=anna.id, **args)
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with ZipFile(BytesIO(single)) as first, ZipFile(BytesIO(multiple)) as all_workers:
        assert first.read("xl/worksheets/sheet1.xml") == all_workers.read(
            "xl/worksheets/sheet1.xml"
        )
        sheet = ET.fromstring(first.read("xl/worksheets/sheet1.xml"))
        other = ET.fromstring(all_workers.read("xl/worksheets/sheet2.xml"))
        for ref in ("I10", "K10", "L10", "I11", "K11", "J12"):
            assert sheet.find(f'.//m:c[@r="{ref}"]/m:is/m:t', ns).text == "x", ref
        for ref in ("J10", "J11", "L11", "E11", "F11", "I12", "K12", "L12", "J14"):
            assert len(sheet.find(f'.//m:c[@r="{ref}"]', ns)) == 0, ref
        assert other.find('.//m:c[@r="J10"]/m:is/m:t', ns).text == "x"
        for ref in ("I10", "K10", "L10", "J11"):
            assert len(other.find(f'.//m:c[@r="{ref}"]', ns)) == 0
    # ZIP-Erstellungszeitpunkte dürfen variieren, die Blattinhalte nicht.
    with ZipFile(BytesIO(single)) as first, ZipFile(BytesIO(repeated)) as again:
        assert {name: first.read(name) for name in first.namelist()} == {
            name: again.read(name) for name in again.namelist()
        }


def test_month_source_range_includes_adjacent_days_when_weeks_match_month_edges():
    assert payroll_month_source_range(2026, 6)[0] == date(2026, 5, 31)
    assert payroll_month_source_range(2026, 5)[1] == date(2026, 6, 1)


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
