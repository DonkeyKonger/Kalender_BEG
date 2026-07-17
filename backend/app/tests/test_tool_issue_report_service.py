from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models.enums import ToolIssueReason, ToolIssueStatus, ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.schemas.mobile import MobileToolIssueReportCreate
from app.schemas.tool_material_item import ToolMaterialItemRead, ToolMaterialItemUpdate
from app.services.dashboard_message_service import DashboardMessageService
from app.services.tool_issue_report_service import ToolIssueReportService
from app.services.tool_material_responsibility_service import ToolMaterialResponsibilityService
from app.services.tool_material_service import ToolMaterialService


def issue_context():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    worker = Person(first_name="Theo", last_name="Erichsen", display_name="Theo Erichsen", short_code="TE")
    other = Person(first_name="Max", last_name="Fremd", display_name="Max Fremd", short_code="MF")
    office_person = Person(first_name="Anna", last_name="Büro", display_name="Anna Büro", short_code="AB")
    worker_user = User(
        username="worker",
        display_name="Theo Erichsen",
        password_hash="x",
        role=UserRole.MONTEUR,
        is_active=True,
        person=worker,
    )
    office_user = User(
        username="office",
        display_name="Anna Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
        office_page_permissions=["miscellaneous"],
        person=office_person,
    )
    admin = User(
        username="admin",
        display_name="Admin",
        password_hash="x",
        role=UserRole.ADMIN,
        is_active=True,
    )
    own_tool = ToolMaterialItem(
        beg_number="25043",
        manufacturer="Bosch",
        designation="Bohrschrauber",
        employee=worker,
        item_date=date(2026, 7, 1),
        status=ToolMaterialStatus.ISSUED,
        remarks="Manuelle Bemerkung",
    )
    foreign_tool = ToolMaterialItem(
        beg_number="999",
        designation="Fremdgerät",
        employee=other,
        status=ToolMaterialStatus.ISSUED,
    )
    warehouse_tool = ToolMaterialItem(
        beg_number="1000",
        designation="Lagergerät",
        status=ToolMaterialStatus.WAREHOUSE,
    )
    db.add_all([worker_user, office_user, admin, own_tool, foreign_tool, warehouse_tool])
    db.commit()
    ToolMaterialResponsibilityService(db).update_responsible_user(office_user.id)
    return db, worker_user, office_user, admin, own_tool, foreign_tool, warehouse_tool


def payload(reason: ToolIssueReason, request_id: str) -> MobileToolIssueReportCreate:
    return MobileToolIssueReportCreate(reason=reason, request_id=request_id)


def test_own_issued_tool_creates_structured_report_and_only_recipient_message():
    db, worker, office, admin, tool, _foreign, _warehouse = issue_context()

    response = ToolIssueReportService(db).report(
        tool_id=tool.id,
        payload=payload(ToolIssueReason.DEFECTIVE, "84ee2b53-796d-4f3d-8959-164f16a04abc"),
        current_user=worker,
    )

    report = db.scalar(select(ToolIssueReport))
    assert report is not None
    assert response.already_reported is False
    assert report.tool_id == tool.id
    assert report.tool_id_snapshot == tool.id
    assert report.reporter_user_id == worker.id
    assert report.reporter_employee_id == worker.person_id
    assert report.reporter_last_name_snapshot == "Erichsen"
    assert report.recipient_user_id == office.id
    assert tool.status == ToolMaterialStatus.ISSUED
    assert tool.employee_id == worker.person_id
    assert tool.remarks == "Manuelle Bemerkung"

    office_summary = DashboardMessageService(db).get_summary(limit=6, current_user=office)
    assert office_summary.open_count == 1
    assert office_summary.latest_messages[0].title == "Werkzeugmeldung: Maschine defekt"
    assert "BEG 25043" in office_summary.latest_messages[0].message_text
    assert office_summary.latest_messages[0].tool_id == tool.id
    assert DashboardMessageService(db).get_summary(limit=6, current_user=admin).open_count == 0
    assert DashboardMessageService(db).get_summary(limit=6, current_user=worker).open_count == 0


def test_idempotency_and_short_duplicate_window_create_one_message():
    db, worker, office, _admin, tool, _foreign, _warehouse = issue_context()
    service = ToolIssueReportService(db)
    request_id = "1b431be5-211b-460d-acf4-52bbd80a8c32"
    first = service.report(tool_id=tool.id, payload=payload(ToolIssueReason.STOLEN, request_id), current_user=worker)
    same_request = service.report(tool_id=tool.id, payload=payload(ToolIssueReason.STOLEN, request_id), current_user=worker)
    duplicate_tap = service.report(
        tool_id=tool.id,
        payload=payload(ToolIssueReason.STOLEN, "d13549b1-1f69-48a1-923f-7e8813d9e385"),
        current_user=worker,
    )

    assert same_request.id == first.id
    assert duplicate_tap.id == first.id
    assert same_request.already_reported is True
    assert db.scalar(select(func.count()).select_from(ToolIssueReport)) == 1
    assert DashboardMessageService(db).get_summary(limit=6, current_user=office).open_count == 1

    report = db.get(ToolIssueReport, first.id)
    report.created_at -= timedelta(minutes=6)
    db.commit()
    later = service.report(
        tool_id=tool.id,
        payload=payload(ToolIssueReason.STOLEN, "0cbe7daf-7b7a-4adb-bd92-3ca4883576bf"),
        current_user=worker,
    )
    assert later.id != first.id
    assert db.scalar(select(func.count()).select_from(ToolIssueReport)) == 2


@pytest.mark.parametrize("tool_name", ["foreign", "warehouse"])
def test_monteur_cannot_report_foreign_or_unissued_tool(tool_name):
    db, worker, _office, _admin, _own, foreign, warehouse = issue_context()
    selected = foreign if tool_name == "foreign" else warehouse
    with pytest.raises(HTTPException) as error:
        ToolIssueReportService(db).report(
            tool_id=selected.id,
            payload=payload(ToolIssueReason.DEFECTIVE, f"b30dc99d-c272-4e95-9a3c-00000000000{1 if tool_name == 'foreign' else 2}"),
            current_user=worker,
        )
    assert error.value.status_code == 409
    assert db.scalar(select(func.count()).select_from(ToolIssueReport)) == 0


def test_missing_or_invalid_responsible_user_rolls_back_everything():
    db, worker, office, _admin, tool, _foreign, _warehouse = issue_context()
    office.office_page_permissions = []
    db.commit()
    with pytest.raises(HTTPException) as error:
        ToolIssueReportService(db).report(
            tool_id=tool.id,
            payload=payload(ToolIssueReason.DEFECTIVE, "8b00261a-c18c-4cd8-b74e-388142a4b083"),
            current_user=worker,
        )
    assert error.value.status_code == 409
    assert "kein Werkzeug-Beauftragter" in error.value.detail
    assert db.scalar(select(func.count()).select_from(ToolIssueReport)) == 0


def test_system_notes_are_separate_from_manual_remarks_and_dismissal_marks_one_message_read():
    db, worker, office, _admin, tool, _foreign, _warehouse = issue_context()
    service = ToolIssueReportService(db)
    first = service.report(
        tool_id=tool.id,
        payload=payload(ToolIssueReason.DEFECTIVE, "3805a8e1-34f8-4aad-82bc-e4d10b9a3952"),
        current_user=worker,
    )
    second = service.report(
        tool_id=tool.id,
        payload=payload(ToolIssueReason.STOLEN, "a8529272-42fa-45f8-8532-2386f3086c8d"),
        current_user=worker,
    )
    item = ToolMaterialService(db).list_items()[1]
    if item.id != tool.id:
        item = next(entry for entry in ToolMaterialService(db).list_items() if entry.id == tool.id)
    assert item.remarks == "Manuelle Bemerkung"
    assert [entry.id for entry in item.open_issue_reports] == [second.id, first.id]
    assert all(entry.status == ToolIssueStatus.OPEN for entry in item.open_issue_reports)
    assert all(entry.reporter_name == "Theo Erichsen" for entry in item.open_issue_reports)

    serialized_item = ToolMaterialItemRead.model_validate(item)
    assert serialized_item.remarks == "Manuelle Bemerkung"
    assert serialized_item.open_issue_reports[0].reporter_name == "Theo Erichsen"
    assert serialized_item.open_issue_reports[0].status == ToolIssueStatus.OPEN

    updated_item = ToolMaterialService(db).update_item(
        tool.id,
        ToolMaterialItemUpdate(remarks="Zusätzliche interne Notiz"),
    )
    assert updated_item.remarks == "Zusätzliche interne Notiz"
    assert [entry.id for entry in updated_item.open_issue_reports] == [second.id, first.id]

    messages = DashboardMessageService(db).get_summary(limit=6, current_user=office).latest_messages
    DashboardMessageService(db).dismiss_message(message_key=messages[0].message_key, current_user=office)
    resolved_report_id = int(messages[0].message_key.rpartition(":")[2])
    resolved_report = db.get(ToolIssueReport, resolved_report_id)
    assert resolved_report is not None
    assert resolved_report.resolved_at is not None
    assert resolved_report.resolved_by_user_id == office.id
    remaining = DashboardMessageService(db).get_summary(limit=6, current_user=office)
    assert remaining.open_count == 1
    assert remaining.latest_messages[0].message_key != messages[0].message_key
    refreshed_item = next(
        entry
        for entry in ToolMaterialService(db).list_items()
        if entry.id == tool.id
    )
    assert [entry.id for entry in refreshed_item.open_issue_reports] == [first.id]

    replacement = service.report(
        tool_id=tool.id,
        payload=payload(
            resolved_report.reason,
            "4e5a3624-a031-4fe7-b633-6403ce244a72",
        ),
        current_user=worker,
    )
    assert replacement.id != resolved_report.id


def test_report_api_uses_authenticated_employee_and_rejects_unauthenticated_requests():
    db, worker, _office, admin, tool, _foreign, _warehouse = issue_context()
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    request_body = {
        "reason": "DEFECTIVE",
        "request_id": "6b0e196e-9e72-41c2-a1f7-8428f22a8138",
        "employee_id": 999_999,
        "recipient_user_id": admin.id,
    }

    assert client.post(f"/api/me/personal-file/tools/{tool.id}/report", json=request_body).status_code == 401

    app.dependency_overrides[get_current_app_user] = lambda: admin
    assert client.post(f"/api/me/personal-file/tools/{tool.id}/report", json=request_body).status_code == 403

    app.dependency_overrides[get_current_app_user] = lambda: worker
    response = client.post(f"/api/me/personal-file/tools/{tool.id}/report", json=request_body)
    assert response.status_code == 201
    report = db.get(ToolIssueReport, response.json()["id"])
    assert report.reporter_employee_id == worker.person_id
    assert report.recipient_user_id != admin.id
