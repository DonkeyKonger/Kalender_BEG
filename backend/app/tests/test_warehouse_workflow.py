from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.main import create_app
from app.models import Base, Person, ToolIssueReport, ToolMaterialItem, User, WarehouseMovement
from app.models.enums import ToolIssueReason, ToolMaterialStatus, UserRole
from app.services.auth_service import AuthService


@pytest.fixture
def warehouse_env():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        users = {}
        for role in UserRole:
            user = User(username=f"test-{role}", display_name=role, role=role,
                        password_hash="not-used", must_change_password=False)
            db.add(user)
            users[role] = user
        people = [Person(first_name=name, last_name="Test", display_name=f"{name} Test", short_code=name)
                  for name in ("Anna", "Bert", "Claus")]
        db.add_all(people)
        db.flush()
        people[2].is_active = False
        tools = [ToolMaterialItem(beg_number="100", designation=f"Bohrer {index}", serial_number=f"S{index}",
                                  supplier="private supplier", invoice_number="private invoice") for index in range(3)]
        tools += [ToolMaterialItem(beg_number="200", designation="Ausgegeben", status=ToolMaterialStatus.ISSUED, employee_id=people[1].id),
                  ToolMaterialItem(beg_number="300", designation="Ausgebucht", status=ToolMaterialStatus.WRITTEN_OFF)]
        db.add_all(tools)
        db.commit()
        app = create_app()
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)
        headers = {role: {"Authorization": f"Bearer {AuthService(db).create_user_token(user)}"} for role, user in users.items()}
        yield db, client, headers, people, tools
        client.close()
    engine.dispose()


def payload(person, items, direction="issue", **changes):
    return {"request_id": str(uuid4()), "direction": direction, "employee_id": person.id,
            "tool_ids": [item.id for item in items],
            "signature_strokes": [[{"x": .1, "y": .3}, {"x": .4, "y": .8}]], **changes}


def post(env, body):
    _, client, headers, _, _ = env
    return client.post("/api/warehouse/movements", headers=headers[UserRole.WAREHOUSE], json=body)


def test_issue_and_return_update_existing_inventory_and_keep_signed_snapshots(warehouse_env):
    db, client, headers, people, tools = warehouse_env
    body = payload(people[0], tools[:2])
    response = post(warehouse_env, body)
    assert response.status_code == 201, response.text
    receipt = response.json()
    assert len(receipt["items"]) == 2
    assert "signature_strokes" not in receipt
    assert "supplier" not in receipt["items"][0]
    db.expire_all()
    assert all(item.status == ToolMaterialStatus.ISSUED and item.employee_id == people[0].id for item in tools[:2])
    assert tools[0].supplier == "private supplier"
    saved = db.get(WarehouseMovement, receipt["id"])
    assert saved.signature_strokes == body["signature_strokes"]
    assert saved.actor_user_id is not None and saved.employee_id_snapshot == people[0].id
    original_name = people[0].display_name
    people[0].display_name = "Renamed"
    tools[0].designation = "Renamed tool"
    db.commit()
    assert saved.employee_name == original_name
    assert saved.items[0]["designation"] == "Bohrer 0"
    assert post(warehouse_env, payload(people[0], tools[:2], "return")).status_code == 201
    db.expire_all()
    assert all(item.status == ToolMaterialStatus.WAREHOUSE and item.employee_id is None for item in tools[:2])
    assert len(db.scalars(select(WarehouseMovement)).all()) == 2


def test_replay_is_idempotent_even_after_later_return(warehouse_env):
    db, _, _, people, tools = warehouse_env
    body = payload(people[0], tools[:2])
    first = post(warehouse_env, body)
    assert first.status_code == 201
    assert post(warehouse_env, body).json() == first.json()
    assert post(warehouse_env, payload(people[0], tools[:2], "return")).status_code == 201
    assert post(warehouse_env, body).json() == first.json()
    db.expire_all()
    assert tools[0].status == ToolMaterialStatus.WAREHOUSE
    assert len(db.scalars(select(WarehouseMovement)).all()) == 2
    body["employee_id"] = people[1].id
    assert post(warehouse_env, body).status_code == 409


@pytest.mark.parametrize("invalid_index", [3, 4])
def test_mixed_unavailable_selection_rolls_back_all_items_and_receipt(warehouse_env, invalid_index):
    db, _, _, people, tools = warehouse_env
    result = post(warehouse_env, payload(people[0], [tools[0], tools[invalid_index]]))
    assert result.status_code == 409
    db.expire_all()
    assert tools[0].status == ToolMaterialStatus.WAREHOUSE
    assert tools[0].employee_id is None
    assert not db.scalars(select(WarehouseMovement)).all()


def test_cannot_return_another_employees_tool_or_missing_tool(warehouse_env):
    db, _, _, people, tools = warehouse_env
    assert post(warehouse_env, payload(people[0], [tools[3]], "return")).status_code == 409
    assert post(warehouse_env, payload(people[0], [], tool_ids=[99999])).status_code == 409
    db.expire_all()
    assert tools[3].employee_id == people[1].id
    assert not db.scalars(select(WarehouseMovement)).all()


def test_stale_issue_cannot_reassign_tool(warehouse_env):
    _, _, _, people, tools = warehouse_env
    assert post(warehouse_env, payload(people[0], [tools[0]])).status_code == 201
    assert post(warehouse_env, payload(people[1], [tools[0]])).status_code == 409


def test_minimal_lists_search_pagination_and_same_beg_number_items(warehouse_env):
    _, client, headers, people, tools = warehouse_env
    auth = headers[UserRole.WAREHOUSE]
    response = client.get("/api/warehouse/people?direction=issue", headers=auth)
    assert [person["id"] for person in response.json()] == [people[0].id, people[1].id]
    assert set(response.json()[0]) == {"id", "display_name", "short_code"}
    url = f"/api/warehouse/tools?direction=issue&employee_id={people[0].id}"
    result = client.get(url + "&search=100&limit=2", headers=auth).json()
    assert result["total"] == 3
    assert [item["id"] for item in result["items"]] == [tools[0].id, tools[1].id]
    assert "invoice_number" not in result["items"][0]
    assert client.get(url + "&search=100&offset=2&limit=2", headers=auth).json()["items"][0]["id"] == tools[2].id
    assert client.get(url + "&search=S2", headers=auth).json()["total"] == 1
    assert client.get(url + "&search=%25", headers=auth).json()["total"] == 0
    result = client.get(f"/api/warehouse/tools?direction=return&employee_id={people[1].id}", headers=auth).json()
    assert [item["id"] for item in result["items"]] == [tools[3].id]


def test_inactive_employee_can_return_but_not_receive_tools(warehouse_env):
    db, client, headers, people, tools = warehouse_env
    tools[3].employee_id = people[2].id
    people[2].deleted_at = datetime.now(timezone.utc)
    db.commit()
    assert post(warehouse_env, payload(people[2], [tools[0]])).status_code == 409
    returned_people = client.get("/api/warehouse/people?direction=return", headers=headers[UserRole.WAREHOUSE]).json()
    assert [person["id"] for person in returned_people] == [people[2].id]
    assert post(warehouse_env, payload(people[2], [tools[3]], "return")).status_code == 201


def test_return_does_not_clear_defect_and_reported_item_cannot_be_reissued(warehouse_env):
    db, client, headers, people, tools = warehouse_env
    report = ToolIssueReport(tool_id=tools[3].id, tool_id_snapshot=tools[3].id, tool_designation_snapshot="Defekt",
                             reporter_last_name_snapshot="Test", reason=ToolIssueReason.DEFECTIVE, request_id=str(uuid4()))
    db.add(report)
    db.commit()
    assert post(warehouse_env, payload(people[1], [tools[3]], "return")).status_code == 201
    assert report.resolved_at is None
    assert post(warehouse_env, payload(people[0], [tools[3]])).status_code == 409
    listed = client.get(f"/api/warehouse/tools?direction=issue&employee_id={people[0].id}&search=200", headers=headers[UserRole.WAREHOUSE])
    assert listed.json()["total"] == 0


@pytest.mark.parametrize("changes", [
    {"signature_strokes": []}, {"signature_strokes": [[{"x": .1, "y": .1}]]},
    {"signature_strokes": [[{"x": .1, "y": .1}, {"x": .1, "y": .1}]]},
    {"signature_strokes": [[{"x": -1, "y": .1}, {"x": .2, "y": .3}]]},
    {"tool_ids": []}, {"tool_ids": [1, 1]}, {"tool_ids": list(range(1, 102))},
    {"direction": "delete"}, {"request_id": "invalid"}, {"actor_user_id": 1},
])
def test_invalid_booking_never_mutates_inventory(warehouse_env, changes):
    db, _, _, people, tools = warehouse_env
    assert post(warehouse_env, payload(people[0], [tools[0]], **changes)).status_code == 422
    assert not db.scalars(select(WarehouseMovement)).all()
    assert tools[0].status == ToolMaterialStatus.WAREHOUSE


@pytest.mark.parametrize("role", [None, UserRole.ADMIN, UserRole.OFFICE, UserRole.PROJECT_MANAGER, UserRole.MONTEUR])
def test_only_warehouse_account_can_use_dedicated_endpoints(warehouse_env, role):
    _, client, headers, people, tools = warehouse_env
    auth = headers.get(role, {})
    expected = 401 if role is None else 403
    assert client.get("/api/warehouse/people?direction=issue", headers=auth).status_code == expected
    assert client.get(f"/api/warehouse/tools?direction=issue&employee_id={people[0].id}", headers=auth).status_code == expected
    assert client.post("/api/warehouse/movements", headers=auth, json=payload(people[0], tools[:1])).status_code == expected
