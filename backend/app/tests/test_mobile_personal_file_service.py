from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.absence import Absence
from app.models.enums import (
    AbsenceStatus,
    AbsenceType,
    ToolIssueReason,
    ToolIssueStatus,
    ToolMaterialCategory,
    ToolMaterialStatus,
    UserRole,
)
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.person_vacation_carryover import PersonVacationCarryover
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.models.vehicle import Vehicle, VehicleAsset
from app.services.mobile_personal_file_service import MobilePersonalFileService


def personal_file_context() -> tuple[Session, User, Person, Person]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    worker = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        annual_vacation_days=30,
    )
    other = Person(
        first_name="Erika",
        last_name="Extern",
        display_name="Erika Extern",
        short_code="EE",
    )
    user = User(
        username="max.monteur",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        is_active=True,
        person=worker,
    )
    db.add_all([worker, other, user])
    db.flush()
    first_hours_entry_at = datetime(2026, 7, 1, 8, 0, tzinfo=timezone.utc)
    latest_hours_entry_at = datetime(2026, 7, 17, 9, 30, tzinfo=timezone.utc)
    db.add(
        PersonVacationCarryover(
            person_id=worker.id,
            year=2026,
            carryover_days=2,
        )
    )
    db.add_all(
        [
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.VACATION,
                start_date=date(2026, 7, 10),
                end_date=date(2026, 7, 13),
                status=AbsenceStatus.ACTIVE,
            ),
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.SICK,
                start_date=date(2026, 1, 3),
                end_date=date(2026, 1, 6),
                status=AbsenceStatus.ACTIVE,
            ),
            Absence(
                person_id=other.id,
                absence_type=AbsenceType.SICK,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 1, 31),
                status=AbsenceStatus.ACTIVE,
            ),
        ]
    )
    db.add_all(
        [
            Vehicle(
                license_plate="OHZ-BE 247",
                name="Volkswagen",
                manufacturer="Volkswagen",
                assigned_person_id=worker.id,
                is_active=True,
            ),
            Vehicle(
                license_plate="FREM D1",
                name="Ford",
                manufacturer="Ford",
                assigned_person_id=other.id,
                is_active=True,
            ),
            VehicleAsset(
                source="ctrack",
                external_id="own-ctrack-vehicle",
                assigned_person_id=worker.id,
                label="C-Track darf nicht die Personalakte speisen",
                vehicle_registration="ALT-CT 1",
                fleet_number="17",
                is_active=True,
            ),
            VehicleAsset(
                source="ctrack",
                external_id="other-ctrack-vehicle",
                assigned_person_id=other.id,
                label="Fremdes Fahrzeug",
                is_active=True,
            ),
        ]
    )
    db.add_all(
        [
            PersonHoursAccountEntry(
                person_id=worker.id,
                entry_type="manual_adjustment",
                minutes_delta=900,
                balance_after_minutes=900,
                note="Startwert",
                created_by_user_id=user.id,
                created_at=first_hours_entry_at,
                updated_at=first_hours_entry_at,
            ),
            PersonHoursAccountEntry(
                person_id=worker.id,
                entry_type="payout",
                minutes_delta=-45,
                balance_after_minutes=855,
                note="Auszahlung",
                created_by_user_id=user.id,
                created_at=latest_hours_entry_at,
                updated_at=latest_hours_entry_at,
            ),
            PersonHoursAccountEntry(
                person_id=other.id,
                entry_type="manual_adjustment",
                minutes_delta=-510,
                balance_after_minutes=-510,
                note="Fremder Stand",
                created_by_user_id=user.id,
                created_at=latest_hours_entry_at,
                updated_at=latest_hours_entry_at,
            ),
            ToolMaterialItem(
                beg_number="BEG-10",
                manufacturer="Bosch",
                designation="Bohrhammer",
                device_number="GER-4711",
                category=ToolMaterialCategory.DRILLING_SCREWING,
                employee_id=worker.id,
                item_date=date(2026, 7, 10),
                status=ToolMaterialStatus.ISSUED,
                serial_number="SECRET-1",
                supplier="Nicht mobil",
            ),
            ToolMaterialItem(
                beg_number="BEG-2",
                designation="Winkelschleifer",
                category=ToolMaterialCategory.GRINDING_CUTTING,
                employee_id=worker.id,
                item_date=date(2026, 7, 10),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-1",
                designation="Sauger",
                category=ToolMaterialCategory.VACUUMING,
                employee_id=worker.id,
                item_date=date(2026, 7, 12),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-OHNE-DATUM",
                designation="Handwerkzeug",
                category=ToolMaterialCategory.HAND_TOOLS,
                employee_id=worker.id,
                item_date=None,
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="LAGER",
                designation="Lagergerät",
                category=ToolMaterialCategory.OTHER,
                status=ToolMaterialStatus.WAREHOUSE,
            ),
            ToolMaterialItem(
                beg_number="AUSGEBUCHT",
                designation="Ausgebucht",
                category=ToolMaterialCategory.OTHER,
                status=ToolMaterialStatus.WRITTEN_OFF,
            ),
            ToolMaterialItem(
                beg_number="FREMD",
                designation="Fremdes Werkzeug",
                category=ToolMaterialCategory.OTHER,
                employee_id=other.id,
                status=ToolMaterialStatus.ISSUED,
            ),
        ]
    )
    db.commit()
    db.refresh(user)
    db.refresh(worker)
    db.refresh(other)
    return db, user, worker, other


def test_personal_file_uses_current_person_and_central_weekday_calculation():
    db, user, _worker, _other = personal_file_context()

    summary = MobilePersonalFileService(db).get_summary(
        current_user=user,
        today=date(2026, 7, 15),
    )

    assert summary.current_year == 2026
    assert summary.total_vacation_days == 32
    assert summary.remaining_vacation_days == 30
    assert summary.sick_days == 2
    assert summary.hours_account.current_balance_minutes == 855
    assert summary.hours_account.last_entry_at is not None
    assert summary.hours_account.last_entry_at.replace(tzinfo=timezone.utc) == datetime(
        2026,
        7,
        17,
        9,
        30,
        tzinfo=timezone.utc,
    )
    assert summary.vehicle is not None
    assert summary.vehicle.license_plate == "OHZ-BE 247"
    assert summary.vehicle.manufacturer == "Volkswagen"
    assert summary.tool_count == 4
    assert [item.beg_number for item in summary.tool_preview] == ["BEG-1", "BEG-2", "BEG-10"]
    db.close()


def test_personal_file_absences_split_cross_week_entries_without_changing_day_totals():
    db, user, worker, _other = personal_file_context()
    vacation = db.scalar(
        select(Absence).where(
            Absence.person_id == worker.id,
            Absence.absence_type == AbsenceType.VACATION,
        )
    )
    assert vacation is not None

    details = MobilePersonalFileService(db).get_absence_details(
        current_user=user,
        year=2026,
        absence_type=AbsenceType.VACATION,
    )

    assert details.total_vacation_days == 32
    assert details.taken_vacation_days == 2
    assert details.remaining_vacation_days == 30
    assert details.vacation_carryover_days == 2
    assert [week.iso_week for week in details.weeks] == [28, 29]
    assert [(week.week_start, week.week_end) for week in details.weeks] == [
        (date(2026, 7, 6), date(2026, 7, 12)),
        (date(2026, 7, 13), date(2026, 7, 19)),
    ]
    assert [entry.day_count for week in details.weeks for entry in week.entries] == [1, 1]
    assert {entry.source_id for week in details.weeks for entry in week.entries} == {vacation.id}
    assert sum(entry.day_count for week in details.weeks for entry in week.entries) == 2
    db.close()


def test_personal_file_absences_group_multiple_entries_once_per_week_and_sort_them():
    db, user, worker, _other = personal_file_context()
    db.add(
        Absence(
            person_id=worker.id,
            absence_type=AbsenceType.VACATION,
            start_date=date(2026, 7, 15),
            end_date=date(2026, 7, 16),
            status=AbsenceStatus.ACTIVE,
        )
    )
    db.commit()

    details = MobilePersonalFileService(db).get_absence_details(
        current_user=user,
        year=2026,
        absence_type=AbsenceType.VACATION,
    )

    week_29 = next(week for week in details.weeks if week.iso_week == 29)
    assert len([week for week in details.weeks if week.iso_week == 29]) == 1
    assert [(entry.start_date, entry.end_date, entry.day_count) for entry in week_29.entries] == [
        (date(2026, 7, 13), date(2026, 7, 13), 1),
        (date(2026, 7, 15), date(2026, 7, 16), 2),
    ]
    assert details.taken_vacation_days == 4
    assert sum(entry.day_count for week in details.weeks for entry in week.entries) == 4
    db.close()


def test_personal_file_absences_merge_only_consecutive_days_inside_the_same_iso_week():
    db, user, worker, _other = personal_file_context()
    db.add_all(
        [
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.VACATION,
                start_date=absence_day,
                end_date=absence_day,
                status=AbsenceStatus.ACTIVE,
            )
            for absence_day in (
                date(2026, 2, 2),
                date(2026, 2, 3),
                date(2026, 2, 5),
                date(2026, 2, 6),
            )
        ]
    )
    db.commit()

    details = MobilePersonalFileService(db).get_absence_details(
        current_user=user,
        year=2026,
        absence_type=AbsenceType.VACATION,
    )

    week_6 = next(week for week in details.weeks if week.iso_week == 6)
    assert [(entry.start_date, entry.end_date, entry.day_count) for entry in week_6.entries] == [
        (date(2026, 2, 2), date(2026, 2, 3), 2),
        (date(2026, 2, 5), date(2026, 2, 6), 2),
    ]
    assert [week.week_start for week in details.weeks] == sorted(
        week.week_start for week in details.weeks
    )
    db.close()


def test_personal_file_absences_clip_year_boundaries_and_keep_iso_week_headers():
    db, user, worker, _other = personal_file_context()
    db.add_all(
        [
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.VACATION,
                start_date=date(2025, 12, 31),
                end_date=date(2026, 1, 2),
                status=AbsenceStatus.ACTIVE,
            ),
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.VACATION,
                start_date=date(2026, 12, 31),
                end_date=date(2027, 1, 4),
                status=AbsenceStatus.ACTIVE,
            ),
        ]
    )
    db.commit()

    details = MobilePersonalFileService(db).get_absence_details(
        current_user=user,
        year=2026,
        absence_type=AbsenceType.VACATION,
    )

    first_week = details.weeks[0]
    last_week = details.weeks[-1]
    assert (first_week.iso_year, first_week.iso_week, first_week.week_start, first_week.week_end) == (
        2026,
        1,
        date(2025, 12, 29),
        date(2026, 1, 4),
    )
    assert [(entry.start_date, entry.end_date, entry.day_count) for entry in first_week.entries] == [
        (date(2026, 1, 1), date(2026, 1, 2), 2),
    ]
    assert (last_week.iso_year, last_week.iso_week) == (2026, 53)
    assert [(entry.start_date, entry.end_date, entry.day_count) for entry in last_week.entries] == [
        (date(2026, 12, 31), date(2026, 12, 31), 1),
    ]
    db.close()


def test_personal_file_absences_return_a_clean_empty_sickness_state():
    db, user, worker, _other = personal_file_context()
    db.query(Absence).filter(
        Absence.person_id == worker.id,
        Absence.absence_type == AbsenceType.SICK,
    ).delete()
    db.commit()

    details = MobilePersonalFileService(db).get_absence_details(
        current_user=user,
        year=2026,
        absence_type=AbsenceType.SICK,
    )

    assert details.sick_days == 0
    assert details.weeks == []
    db.close()


def test_personal_file_hours_account_supports_negative_zero_and_empty_states():
    db, user, worker, _other = personal_file_context()
    db.query(PersonHoursAccountEntry).filter(
        PersonHoursAccountEntry.person_id == worker.id
    ).delete()
    db.commit()
    service = MobilePersonalFileService(db)

    empty_summary = service.get_summary(current_user=user, today=date(2026, 7, 15))
    assert empty_summary.hours_account.current_balance_minutes == 0
    assert empty_summary.hours_account.last_entry_at is None

    now = datetime(2026, 7, 18, 7, 0, tzinfo=timezone.utc)
    db.add(
        PersonHoursAccountEntry(
            person_id=worker.id,
            entry_type="manual_adjustment",
            minutes_delta=-510,
            balance_after_minutes=-510,
            note="Minusstunden",
            created_by_user_id=user.id,
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()
    negative_summary = service.get_summary(current_user=user, today=date(2026, 7, 18))
    assert negative_summary.hours_account.current_balance_minutes == -510
    assert negative_summary.hours_account.last_entry_at is not None
    assert negative_summary.hours_account.last_entry_at.replace(tzinfo=timezone.utc) == now

    db.add(
        PersonHoursAccountEntry(
            person_id=worker.id,
            entry_type="manual_adjustment",
            minutes_delta=510,
            balance_after_minutes=0,
            note="Ausgleich",
            created_by_user_id=user.id,
            created_at=now + timedelta(hours=1),
            updated_at=now + timedelta(hours=1),
        )
    )
    db.commit()
    zero_summary = service.get_summary(current_user=user, today=date(2026, 7, 18))
    assert zero_summary.hours_account.current_balance_minutes == 0
    assert zero_summary.hours_account.last_entry_at is not None
    assert zero_summary.hours_account.last_entry_at.replace(tzinfo=timezone.utc) == now + timedelta(
        hours=1
    )
    db.close()


def test_personal_file_tool_list_is_reduced_sorted_and_excludes_other_statuses():
    db, user, _worker, _other = personal_file_context()

    tools = MobilePersonalFileService(db).list_tools(current_user=user)

    assert [item.beg_number for item in tools] == [
        "BEG-1",
        "BEG-2",
        "BEG-10",
        "BEG-OHNE-DATUM",
    ]
    assert {item.category for item in tools} == {
        ToolMaterialCategory.DRILLING_SCREWING,
        ToolMaterialCategory.GRINDING_CUTTING,
        ToolMaterialCategory.VACUUMING,
        ToolMaterialCategory.HAND_TOOLS,
    }
    db.close()


def test_personal_file_vehicle_empty_state_does_not_fall_back_to_foreign_vehicle():
    db, user, worker, _other = personal_file_context()
    own_vehicle = db.scalar(select(Vehicle).where(Vehicle.assigned_person_id == worker.id))
    assert own_vehicle is not None
    db.delete(own_vehicle)
    db.commit()

    summary = MobilePersonalFileService(db).get_summary(
        current_user=user,
        today=date(2026, 7, 15),
    )

    assert summary.vehicle is None
    db.close()


def test_personal_file_api_ignores_manipulated_person_id_and_exposes_no_admin_fields():
    db, user, _worker, other = personal_file_context()
    app = create_app()
    app.dependency_overrides[get_current_app_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    summary_response = client.get(f"/api/me/personal-file?person_id={other.id}")
    absence_response = client.get(
        f"/api/me/personal-file/absences?absence_type=sick&year=2026&person_id={other.id}"
    )
    tools_response = client.get(f"/api/me/personal-file/tools?person_id={other.id}")

    assert summary_response.status_code == 200
    assert summary_response.json()["vehicle"]["license_plate"] == "OHZ-BE 247"
    assert summary_response.json()["vehicle"]["manufacturer"] == "Volkswagen"
    assert summary_response.json()["hours_account"]["current_balance_minutes"] == 855
    assert summary_response.json()["tool_count"] == 4
    assert absence_response.status_code == 200
    assert absence_response.json()["sick_days"] == 2
    assert absence_response.json()["weeks"][0]["entries"][0]["day_count"] == 2
    assert tools_response.status_code == 200
    assert {item["beg_number"] for item in tools_response.json()} == {
        "BEG-1",
        "BEG-2",
        "BEG-10",
        "BEG-OHNE-DATUM",
    }
    assert set(tools_response.json()[0]) == {
        "category",
        "id",
        "beg_number",
        "manufacturer",
        "designation",
        "device_number",
        "item_date",
        "open_issue_reports",
    }
    assert "serial_number" not in tools_response.json()[0]
    assert "supplier" not in tools_response.json()[0]
    assert "employee_id" not in tools_response.json()[0]
    app.dependency_overrides.clear()
    db.close()


def test_personal_file_lists_only_own_open_tool_reports_newest_first():
    db, user, worker, other = personal_file_context()
    own_tool = db.scalar(select(ToolMaterialItem).where(ToolMaterialItem.beg_number == "BEG-10"))
    other_own_tool = db.scalar(
        select(ToolMaterialItem).where(ToolMaterialItem.beg_number == "BEG-2")
    )
    foreign_tool = db.scalar(select(ToolMaterialItem).where(ToolMaterialItem.beg_number == "FREMD"))
    assert own_tool is not None and other_own_tool is not None and foreign_tool is not None
    now = datetime.now(timezone.utc)

    older = ToolIssueReport(
        tool=own_tool,
        tool_id_snapshot=own_tool.id,
        tool_beg_number_snapshot=own_tool.beg_number,
        tool_designation_snapshot=own_tool.designation,
        reason=ToolIssueReason.DEFECTIVE,
        status=ToolIssueStatus.OPEN,
        reporter_user_id=user.id,
        reporter_employee_id=worker.id,
        reporter_last_name_snapshot=worker.last_name,
        request_id="0b953238-c8c3-4b69-b402-a20869793001",
        created_at=now - timedelta(hours=2),
    )
    newest = ToolIssueReport(
        tool=own_tool,
        tool_id_snapshot=own_tool.id,
        tool_beg_number_snapshot=own_tool.beg_number,
        tool_designation_snapshot=own_tool.designation,
        reason=ToolIssueReason.STOLEN,
        status=ToolIssueStatus.OPEN,
        reporter_user_id=user.id,
        reporter_employee_id=worker.id,
        reporter_last_name_snapshot=worker.last_name,
        request_id="0b953238-c8c3-4b69-b402-a20869793002",
        created_at=now - timedelta(hours=1),
    )
    resolved = ToolIssueReport(
        tool=own_tool,
        tool_id_snapshot=own_tool.id,
        tool_beg_number_snapshot=own_tool.beg_number,
        tool_designation_snapshot=own_tool.designation,
        reason=ToolIssueReason.DEFECTIVE,
        status=ToolIssueStatus.OPEN,
        reporter_user_id=user.id,
        reporter_employee_id=worker.id,
        reporter_last_name_snapshot=worker.last_name,
        resolved_at=now,
        request_id="0b953238-c8c3-4b69-b402-a20869793003",
    )
    other_tool_report = ToolIssueReport(
        tool=other_own_tool,
        tool_id_snapshot=other_own_tool.id,
        tool_beg_number_snapshot=other_own_tool.beg_number,
        tool_designation_snapshot=other_own_tool.designation,
        reason=ToolIssueReason.DEFECTIVE,
        status=ToolIssueStatus.OPEN,
        reporter_user_id=user.id,
        reporter_employee_id=worker.id,
        reporter_last_name_snapshot=worker.last_name,
        request_id="0b953238-c8c3-4b69-b402-a20869793004",
    )
    foreign_report = ToolIssueReport(
        tool=foreign_tool,
        tool_id_snapshot=foreign_tool.id,
        tool_beg_number_snapshot=foreign_tool.beg_number,
        tool_designation_snapshot=foreign_tool.designation,
        reason=ToolIssueReason.DEFECTIVE,
        status=ToolIssueStatus.OPEN,
        reporter_employee_id=other.id,
        reporter_last_name_snapshot=other.last_name,
        request_id="0b953238-c8c3-4b69-b402-a20869793005",
    )
    db.add_all([older, newest, resolved, other_tool_report, foreign_report])
    db.commit()

    tools = MobilePersonalFileService(db).list_tools(current_user=user)
    tool = next(item for item in tools if item.id == own_tool.id)
    other_tool = next(item for item in tools if item.id == other_own_tool.id)

    assert tool.device_number == "GER-4711"
    assert [report.id for report in tool.open_issue_reports] == [newest.id, older.id]
    assert [report.reason for report in tool.open_issue_reports] == [
        ToolIssueReason.STOLEN,
        ToolIssueReason.DEFECTIVE,
    ]
    assert all(report.status == "open" for report in tool.open_issue_reports)
    assert other_tool.open_issue_reports[0].id == other_tool_report.id
    assert all(
        report.id != foreign_report.id for item in tools for report in item.open_issue_reports
    )

    newest.resolved_at = now
    older.resolved_at = now
    db.commit()
    refreshed = MobilePersonalFileService(db).list_tools(current_user=user)
    refreshed_tool = next(item for item in refreshed if item.id == own_tool.id)
    assert refreshed_tool.open_issue_reports == []
    db.close()


def test_personal_file_reflects_assignment_changes_on_next_request():
    db, user, worker, other = personal_file_context()
    service = MobilePersonalFileService(db)
    item = next(item for item in db.query(ToolMaterialItem).all() if item.beg_number == "BEG-1")
    assert service.get_summary(current_user=user, today=date(2026, 7, 15)).tool_count == 4

    item.employee_id = other.id
    db.commit()

    assert service.get_summary(current_user=user, today=date(2026, 7, 15)).tool_count == 3
    assert item.employee_id != worker.id
    db.close()


def test_personal_file_handles_missing_person_and_rejects_other_roles():
    db, user, _worker, _other = personal_file_context()
    user.person_id = None
    with pytest.raises(HTTPException) as missing_error:
        MobilePersonalFileService(db).get_summary(current_user=user, today=date(2026, 7, 15))
    assert missing_error.value.status_code == 400

    user.role = UserRole.PROJECT_MANAGER
    with pytest.raises(HTTPException) as role_error:
        MobilePersonalFileService(db).get_summary(current_user=user, today=date(2026, 7, 15))
    assert role_error.value.status_code == 403
    with pytest.raises(HTTPException) as detail_role_error:
        MobilePersonalFileService(db).get_absence_details(
            current_user=user,
            year=2026,
            absence_type=AbsenceType.VACATION,
        )
    assert detail_role_error.value.status_code == 403
    db.close()
