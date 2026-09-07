from io import BytesIO
import json
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from fastapi import HTTPException, FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy import create_engine, text, inspect
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.api.dependencies import get_current_user
from app.api.routes import payroll_months
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApproval
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.payroll_remarks import remarks_layout, validate_remarks, wrap_remarks
from app.tests.test_payroll_month_close_service import database, payroll_users


@pytest.fixture
def case(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    args = dict(year=2026, month=8, person_id=worker.id, current_user=admin)
    yield SimpleNamespace(db=db, admin=admin, worker=worker, service=service, args=args)
    db.close()


def test_font_widths_and_wrapping_match_shared_browser_cases():
    fixture = json.loads((Path(__file__).parent / "fixtures/payroll_remarks.json").read_text())
    assert remarks_layout() == fixture["layout"]
    for item in fixture["cases"]:
        assert wrap_remarks(item["text"]) == item["lines"]
        for line in item["lines"]:
            assert sum(remarks_layout()["character_widths"].get(c, 2000) for c in line) <= 14400
        if item["valid"]:
            validate_remarks(item["text"])
        else:
            with pytest.raises(ValueError):
                validate_remarks(item["text"])


def test_migration_keeps_existing_approvals_and_can_be_reversed(monkeypatch):
    path = Path(__file__).parents[2] / "alembic/versions/20260907_0114_add_payroll_month_remarks.py"
    spec = importlib.util.spec_from_file_location("remarks_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE payroll_month_person_approvals (id INTEGER PRIMARY KEY, status TEXT)"))
        connection.execute(text("INSERT INTO payroll_month_person_approvals VALUES (1, 'APPROVED')"))
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        assert connection.execute(text("SELECT id, status, remarks FROM payroll_month_person_approvals")).one() == (1, "APPROVED", None)
        migration.downgrade()
        assert [c["name"] for c in inspect(connection).get_columns("payroll_month_person_approvals")] == ["id", "status"]
        assert connection.execute(text("SELECT status FROM payroll_month_person_approvals")).scalar() == "APPROVED"


def test_remarks_are_persisted_per_person_month_and_can_be_edited_and_cleared(case):
    assert case.service.get_person_remarks(**case.args).remarks == ""
    assert not case.db.new and not case.db.dirty
    case.service.save_person_remarks(**case.args, remarks="Bitte Reisekosten prüfen.")
    case.db.expire_all()
    assert case.service.get_person_remarks(**case.args).remarks == "Bitte Reisekosten prüfen."
    assert case.service.get_person_remarks(**{**case.args, "month": 9}).remarks == ""
    case.service.save_person_remarks(**case.args, remarks="Geänderter Text")
    case.service.save_person_remarks(**case.args, remarks="")
    assert case.service.get_person_remarks(**case.args).remarks == ""
    assert case.db.scalar(select(PayrollMonthPersonApproval)).status == "OPEN"


@pytest.mark.parametrize("text", ["W" * 61, "1\n2\n3\n4\n5", "a" * 513, "Text\x00"])
def test_overflow_and_xml_controls_are_rejected_without_changing_saved_remarks(case, text):
    case.service.save_person_remarks(**case.args, remarks="Original")
    with pytest.raises(HTTPException) as caught:
        case.service.save_person_remarks(**case.args, remarks=text)
    assert caught.value.status_code == 422
    assert case.service.get_person_remarks(**case.args).remarks == "Original"


@pytest.mark.parametrize("lock", ["person", "month"])
def test_server_rejects_stale_popup_save_after_approval_or_global_lock(case, lock):
    case.service.save_person_remarks(**case.args, remarks="Original")
    if lock == "person":
        case.db.scalar(select(PayrollMonthPersonApproval)).status = "APPROVED"
    else:
        case.db.scalar(select(PayrollMonthPeriod)).status = "LOCKED"
    case.db.commit()
    assert not case.service.get_person_remarks(**case.args).editable
    with pytest.raises(HTTPException) as caught:
        case.service.save_person_remarks(**case.args, remarks="Später geändert")
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_remarks_locked"
    assert case.service.get_person_remarks(**case.args).remarks == "Original"


def _printed_lines(content, index=1):
    with ZipFile(BytesIO(content)) as workbook:
        sheet = ET.fromstring(workbook.read(f"xl/worksheets/sheet{index}.xml"))
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    return ["".join(sheet.findall(f'.//s:c[@r="I{row}"]//s:t', ns)[0].itertext())
            if sheet.findall(f'.//s:c[@r="I{row}"]//s:t', ns) else "" for row in range(46, 50)]


def test_approved_single_and_combined_exports_retain_all_four_lines(case):
    text = "Bitte Reisekosten prüfen.\nZulage beachten.\nRückfrage im Büro.\nDanke."
    case.service.save_person_remarks(**case.args, remarks=text)
    case.service.approve_person_month(**case.args, confirmed=True, acknowledged_blocker_count=0)
    export = PayrollMonthExportService(case.db)
    before = export.worker_export(**case.args)
    assert _printed_lines(before) == text.split("\n")
    combined = export.all_workers_export(year=2026, month=8, current_user=case.admin)
    assert _printed_lines(combined) == text.split("\n")
    with pytest.raises(HTTPException):
        case.service.save_person_remarks(**case.args, remarks="Verbotene Änderung")
    assert export.worker_export(**case.args) == before
    case.service.reopen_person_month(**case.args, reason="Korrektur nötig")
    assert case.service.get_person_remarks(**case.args).remarks == text
    case.service.save_person_remarks(**case.args, remarks="Korrigiert")
    case.service.approve_person_month(**case.args, confirmed=True, acknowledged_blocker_count=0)
    assert _printed_lines(export.worker_export(**case.args)) == ["Korrigiert", "", "", ""]


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.MONTEUR, [], 403), (UserRole.OFFICE, [], 403),
    (UserRole.OFFICE, ["payroll"], 200), (UserRole.ADMIN, [], 200),
])
def test_route_permissions_and_request_length(monkeypatch, role, permissions, expected):
    app = FastAPI()
    app.include_router(payroll_months.router)
    user = SimpleNamespace(id=7, role=role, office_page_permissions=permissions,
                           is_active=True, must_change_password=False, person_id=None)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None
    monkeypatch.setattr(PayrollMonthCloseService, "save_person_remarks", lambda *args, **kwargs: {
        "remarks": kwargs["remarks"], "editable": True, "layout": remarks_layout(),
    })
    with TestClient(app) as client:
        url = "/payroll-months/2026/8/people/1/remarks"
        assert client.put(url, json={"remarks": "Hallo"}).status_code == expected
        if expected == 200:
            assert client.put(url, json={"remarks": "i" * 513}).status_code == 422
