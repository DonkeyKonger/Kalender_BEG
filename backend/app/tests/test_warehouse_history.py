from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import AuditLog, Base, Person, ToolMaterialItem, User, WarehouseMovement
from app.models.tool_material_settings import ToolMaterialSettings
from app.models.enums import UserRole
from app.schemas.warehouse import WarehouseHistoryQuery, WarehouseMovementCreate
from app.services.warehouse_history_service import WarehouseHistoryService
from app.services.warehouse_service import WarehouseService

BASE_URL = "/api/admin/tool-material-items/movements"


@pytest.fixture
def history_env():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        admin = User(username="history-admin", display_name="Prüfadmin", role=UserRole.ADMIN, password_hash="unused")
        db.add(admin)
        db.commit()
        app = create_app()
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_current_user] = lambda: admin
        client = TestClient(app)
        yield db, client, app
        client.close()
    engine.dispose()


def add_receipt(db, *, employee="Max Müller", direction="issue", created_at=None, number="BEG-42", designation="Prüfgerät"):
    receipt = WarehouseMovement(request_id=str(uuid4()), request_hash="private-hash", direction=direction,
        employee_id_snapshot=42, employee_name=employee, actor_name="Lager Tablet", items=[{
            "id": 7, "beg_number": number, "designation": designation, "manufacturer": "Bosch", "item_type": "Testgerät",
            "device_number": "Gerät-7", "serial_number": "Serial-8", "category": "testing_equipment",
        }], signature_strokes=[[{"x": .1, "y": .1}, {"x": .7, "y": .8}]],
        created_at=created_at or datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc))
    db.add(receipt)
    db.commit()
    return receipt


def test_list_is_paginated_newest_first_and_omits_signature_and_request_data(history_env):
    db, client, _ = history_env
    ids = [add_receipt(db).id for _ in range(3)]
    response = client.get(BASE_URL + "?page_size=2")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["total"] == 3 and result["page"] == 1
    assert [item["id"] for item in result["items"]] == ids[::-1][:2]
    assert response.headers["Cache-Control"] == "no-store"
    assert set(result["items"][0]) == {"id", "direction", "employee_name", "items", "created_at", "actor_name",
                                        "review_status", "reviewed_at", "reviewed_by_name", "review_version"}
    assert result["items"][0]["review_status"] == "unreviewed"
    assert result["items"][0]["review_version"] == 0
    assert client.get(BASE_URL + "?page_size=2&page=2").json()["items"][0]["id"] == ids[0]
    assert client.get(BASE_URL + "?page_size=2&page=3").json()["items"] == []
    db.expunge_all()
    rows, _ = WarehouseHistoryService(db).list_page(WarehouseHistoryQuery())
    assert all("signature_strokes" in inspect(row).unloaded for row in rows)


@pytest.mark.parametrize("search", ["Müller", "Lager", "BEG-42", "Prüfgerät", "Bosch", "Testgerät", "Gerät-7", "Serial-8"])
def test_searches_snapshot_values_without_duplicates(history_env, search):
    db, client, _ = history_env
    record = add_receipt(db)
    record.items = record.items * 2
    db.commit()
    result = client.get(BASE_URL, params={"search": search}).json()
    assert result["total"] == 1
    assert len(result["items"]) == 1


def test_search_does_not_match_json_keys_or_treat_input_as_wildcards(history_env):
    db, client, _ = history_env
    record = add_receipt(db)
    for search in ["beg_number", "%", "_", "does-not-exist"]:
        assert client.get(BASE_URL, params={"search": search}).json()["total"] == 0
    assert client.get(BASE_URL, params={"search": f"#{record.id}"}).json()["total"] == 1


def test_date_filter_uses_berlin_calendar_days_and_can_combine_direction(history_env):
    db, client, _ = history_env
    before = add_receipt(db, created_at=datetime(2026, 9, 28, 21, 59, tzinfo=timezone.utc))
    start = add_receipt(db, direction="return", created_at=datetime(2026, 9, 28, 22, 0, tzinfo=timezone.utc))
    end = add_receipt(db, created_at=datetime(2026, 9, 29, 21, 59, tzinfo=timezone.utc))
    after = add_receipt(db, created_at=datetime(2026, 9, 29, 22, 0, tzinfo=timezone.utc))
    result = client.get(BASE_URL, params={"date_from": "2026-09-29", "date_to": "2026-09-29"}).json()
    assert [entry["id"] for entry in result["items"]] == [end.id, start.id]
    assert before.id not in [entry["id"] for entry in result["items"]]
    assert after.id not in [entry["id"] for entry in result["items"]]
    result = client.get(BASE_URL, params={"date_from": "2026-09-29", "date_to": "2026-09-29", "direction": "return"}).json()
    assert [entry["id"] for entry in result["items"]] == [start.id]


def test_real_tablet_bookings_appear_with_original_signature_after_master_data_change(history_env):
    db, client, _ = history_env
    actor = User(username="qa", display_name="Altes Lager", role=UserRole.WAREHOUSE, password_hash="unused")
    person = Person(first_name="QA", last_name="Test", display_name="Original Monteur", short_code="QT")
    item = ToolMaterialItem(beg_number="ONE", designation="Original Werkzeug")
    db.add_all([actor, person, item])
    db.commit()
    signatures = [[{"x": .1, "y": .2}, {"x": .5, "y": .7}]]
    ids = []
    for direction in ("issue", "return"):
        result = WarehouseService(db).book(WarehouseMovementCreate(
            request_id=uuid4(), direction=direction, employee_id=person.id,
            tool_ids=[item.id], signature_strokes=signatures,
        ), actor)
        ids.append(result.id)
    person.display_name = "Changed person"
    actor.display_name = "Changed actor"
    item.designation = "Changed tool"
    db.commit()
    assert client.get(BASE_URL).json()["total"] == 2
    for receipt_id in ids:
        response = client.get(f"{BASE_URL}/{receipt_id}")
        assert response.status_code == 200
        record = response.json()
        assert record["signature_strokes"] == signatures
        assert record["employee_name"] == "Original Monteur"
        assert record["actor_name"] == "Altes Lager"
        assert record["items"][0]["designation"] == "Original Werkzeug"
        assert "request_hash" not in record and "request_id" not in record
        assert response.headers["Cache-Control"] == "no-store"
    # Reading the log must never create, edit or remove inventory/bookings.
    assert len(db.scalars(select(WarehouseMovement)).all()) == 2
    assert item.employee_id is None
    assert client.get(f"{BASE_URL}/99999").status_code == 404


@pytest.mark.parametrize("params", [{"page": 0}, {"page_size": 101}, {"direction": "delete"},
    {"search": "a" * 161}, {"date_from": "2026-09-30", "date_to": "2026-09-29"}, {"date_from": "bad"}, {"review_status": "invalid"}])
def test_invalid_filters_rejected(history_env, params):
    _, client, _ = history_env
    assert client.get(BASE_URL, params=params).status_code == 422


@pytest.mark.parametrize(("role", "permissions", "expected"), [
    (UserRole.ADMIN, [], 200), (UserRole.OFFICE, ["miscellaneous"], 200),
    (UserRole.OFFICE, [], 403), (UserRole.PROJECT_MANAGER, ["miscellaneous"], 403),
    (UserRole.MONTEUR, [], 403), (UserRole.WAREHOUSE, [], 403),
])
def test_log_and_signature_have_same_permissions_as_inventory(history_env, role, permissions, expected):
    db, client, app = history_env
    receipt = add_receipt(db)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role=role, is_active=True,
        must_change_password=False, office_page_permissions=permissions)
    assert client.get(BASE_URL).status_code == expected
    assert client.get(f"{BASE_URL}/{receipt.id}").status_code == expected


def test_log_requires_login_and_has_no_mutation_routes(history_env):
    db, client, app = history_env
    record = add_receipt(db)
    del app.dependency_overrides[get_current_user]
    assert client.get(BASE_URL).status_code == 401
    assert client.get(f"{BASE_URL}/{record.id}").status_code == 401
    for method in ("POST", "PATCH", "DELETE"):
        assert client.request(method, f"{BASE_URL}/{record.id}", json={}).status_code == 405
    assert client.patch(f"{BASE_URL}/{record.id}/review", json={"reviewed": True, "expected_version": 0}).status_code == 401


def test_review_toggle_is_persistent_audited_idempotent_and_preserves_receipt(history_env):
    db, client, _ = history_env
    receipt = add_receipt(db)
    original = (receipt.items, receipt.signature_strokes, receipt.employee_name, receipt.created_at)
    url = f"{BASE_URL}/{receipt.id}/review"
    first = client.patch(url, json={"reviewed": True, "expected_version": 0})
    assert first.status_code == 200, first.text
    result = first.json()
    assert result["review_status"] == "reviewed" and result["review_version"] == 1
    assert result["reviewed_by_name"] == "Prüfadmin" and result["reviewed_at"]
    assert "signature_strokes" not in result
    assert client.patch(url, json={"reviewed": True, "expected_version": 0}).json() == result
    assert client.get(BASE_URL + "?review_status=reviewed").json()["total"] == 1
    assert client.get(BASE_URL + "?review_status=unreviewed").json()["total"] == 0
    assert client.get(f"{BASE_URL}/{receipt.id}").json()["review_status"] == "reviewed"
    reset = client.patch(url, json={"reviewed": False, "expected_version": 1})
    assert reset.status_code == 200
    assert reset.json()["review_status"] == "unreviewed" and reset.json()["review_version"] == 2
    assert reset.json()["reviewed_at"] is None and reset.json()["reviewed_by_name"] is None
    assert client.patch(url, json={"reviewed": True, "expected_version": 0}).status_code == 409
    assert (receipt.items, receipt.signature_strokes, receipt.employee_name, receipt.created_at) == original
    audits = db.scalars(select(AuditLog).order_by(AuditLog.id)).all()
    assert [a.action for a in audits] == ["warehouse_movement.reviewed", "warehouse_movement.review_reset"]
    assert audits[1].old_value_json["reviewed_by_name"] == "Prüfadmin"
    assert "signature_strokes" not in audits[0].new_value_json


@pytest.mark.parametrize("kind", ["responsible", "other_office", "inactive", "external_person", "no_permission", "monteur", "warehouse", "project_manager", "missing_settings"])
def test_only_valid_responsible_user_or_admin_may_review(history_env, kind):
    db, client, app = history_env
    receipt = add_receipt(db)
    person = Person(first_name="QA", last_name="Office", display_name="Office", short_code="QO")
    db.add(person)
    db.flush()
    reviewer = User(username="responsible", display_name="Beauftragter", role=UserRole.OFFICE,
                    person_id=person.id, password_hash="unused", office_page_permissions=["miscellaneous"])
    db.add(reviewer)
    db.flush()
    db.add(ToolMaterialSettings(id=1, tool_responsible_user_id=None if kind == "missing_settings" else reviewer.id))
    current = reviewer
    if kind == "other_office":
        current = User(username="other", display_name="Other", role=UserRole.OFFICE, password_hash="unused", office_page_permissions=["miscellaneous"])
        db.add(current)
    elif kind == "inactive":
        person.is_active = False
    elif kind == "external_person":
        person.person_type = "external"
    elif kind == "no_permission":
        reviewer.office_page_permissions = []
    elif kind in {"monteur", "warehouse", "project_manager"}:
        reviewer.role = UserRole(kind)
        if kind == "warehouse":
            reviewer.person_id = None
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: current
    response = client.patch(f"{BASE_URL}/{receipt.id}/review", json={"reviewed": True, "expected_version": 0})
    assert response.status_code == (200 if kind == "responsible" else 403), response.text
    page = client.get(BASE_URL)
    if page.status_code == 200:
        assert page.json()["can_review"] == (kind == "responsible")
    if kind != "responsible":
        assert receipt.reviewed_at is None
        assert not db.scalars(select(AuditLog)).all()


@pytest.mark.parametrize("payload", [{}, {"reviewed": "true", "expected_version": 0}, {"reviewed": True, "expected_version": -1},
    {"reviewed": True, "expected_version": 0, "reviewed_by_name": "Forged"}])
def test_review_rejects_invalid_payload(history_env, payload):
    db, client, _ = history_env
    receipt = add_receipt(db)
    assert client.patch(f"{BASE_URL}/{receipt.id}/review", json=payload).status_code == 422
    assert receipt.reviewed_at is None


def test_review_missing_receipt(history_env):
    _, client, _ = history_env
    assert client.patch(f"{BASE_URL}/99999/review", json={"reviewed": True, "expected_version": 0}).status_code == 404
