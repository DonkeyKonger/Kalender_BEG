from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.absence import Absence
from app.models.audit_log import AuditLog
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.person import Person
from app.models.user import User


@pytest.fixture
def absence_route_case():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    absent_person = Person(
        first_name="Mara",
        last_name="Test",
        display_name="Mara Test",
        short_code="MT",
        person_type=PersonType.INTERNAL,
    )
    creator_person = Person(
        first_name="Christopher",
        last_name="Erichsen",
        display_name="Christopher Erichsen",
        short_code="CE",
        person_type=PersonType.INTERNAL,
    )
    creator = User(
        username="creator",
        display_name="Christopher Erichsen",
        password_hash="x",
        role=UserRole.ADMIN,
        person=creator_person,
    )
    editor = User(
        username="editor",
        display_name="Anna Büro",
        password_hash="x",
        role=UserRole.ADMIN,
    )
    db.add_all([absent_person, creator, editor])
    db.commit()
    ids = {
        "person": absent_person.id,
        "creator": creator.id,
        "editor": editor.id,
    }
    current = {
        "user": SimpleNamespace(
            id=creator.id,
            role=UserRole.ADMIN,
            is_active=True,
            must_change_password=False,
            office_page_permissions=[],
        )
    }
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    yield client, db, current, ids

    app.dependency_overrides.clear()
    db.close()


def absence_payload(person_id: int, start_date: str, end_date: str) -> dict:
    return {
        "person_id": person_id,
        "absence_type": "vacation",
        "start_date": start_date,
        "end_date": end_date,
        "status": "active",
        "note": "Urlaub",
    }


def principal(user_id: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=user_id,
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )


def test_absence_responses_resolve_original_creator_without_list_n_plus_one(
    absence_route_case,
):
    client, db, current, ids = absence_route_case
    created = client.post(
        "/api/absences",
        json=absence_payload(ids["person"], "2026-11-02", "2026-11-03"),
    )

    assert created.status_code == 201
    assert created.json()["created_by_name"] == "Christopher Erichsen"
    assert created.json()["created_by_short_code"] == "CE"
    created_id = created.json()["id"]

    unknown_creator = Absence(
        person_id=ids["person"],
        absence_type=AbsenceType.SICK,
        start_date=date(2026, 11, 9),
        end_date=date(2026, 11, 9),
        status=AbsenceStatus.ACTIVE,
        created_by_user_id=None,
        updated_by_user_id=None,
    )
    db.add(unknown_creator)
    db.commit()
    unknown_id = unknown_creator.id
    db.expunge_all()

    selects: list[str] = []

    def record_select(_connection, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    event.listen(db.bind, "before_cursor_execute", record_select)
    try:
        listed = client.get("/api/absences")
    finally:
        event.remove(db.bind, "before_cursor_execute", record_select)

    assert listed.status_code == 200
    assert len(selects) == 1
    listed_by_id = {item["id"]: item for item in listed.json()}
    assert listed_by_id[created_id]["created_by_name"] == "Christopher Erichsen"
    assert listed_by_id[created_id]["created_by_short_code"] == "CE"
    assert listed_by_id[unknown_id]["created_by_name"] is None
    assert listed_by_id[unknown_id]["created_by_short_code"] is None

    current["user"] = principal(ids["editor"])
    updated = client.patch(f"/api/absences/{created_id}", json={"note": "Geändert"})

    assert updated.status_code == 200
    assert updated.json()["created_by_name"] == "Christopher Erichsen"
    assert updated.json()["created_by_short_code"] == "CE"
    persisted = db.get(Absence, created_id)
    assert persisted.created_by_user_id == ids["creator"]
    assert persisted.updated_by_user_id == ids["editor"]

    fallback = client.post(
        "/api/absences",
        json=absence_payload(ids["person"], "2026-11-16", "2026-11-16"),
    )

    assert fallback.status_code == 201
    assert fallback.json()["created_by_name"] == "Anna Büro"
    assert fallback.json()["created_by_short_code"] == "AB"


def test_remove_absence_day_endpoint_splits_atomically_and_keeps_creator(
    absence_route_case,
):
    client, db, current, ids = absence_route_case
    created = client.post(
        "/api/absences",
        json=absence_payload(ids["person"], "2026-11-02", "2026-11-06"),
    ).json()
    current["user"] = principal(ids["editor"])

    response = client.delete(f"/api/absences/{created['id']}/days/2026-11-04")

    assert response.status_code == 200
    assert [
        (item["start_date"], item["end_date"])
        for item in response.json()
    ] == [
        ("2026-11-02", "2026-11-03"),
        ("2026-11-05", "2026-11-06"),
    ]
    assert {item["created_by_name"] for item in response.json()} == {
        "Christopher Erichsen"
    }
    assert {item["created_by_short_code"] for item in response.json()} == {"CE"}
    assert {item["created_at"] for item in response.json()} == {created["created_at"]}

    fragments = list(
        db.scalars(
            select(Absence)
            .where(Absence.person_id == ids["person"])
            .order_by(Absence.start_date)
        )
    )
    assert [fragment.created_by_user_id for fragment in fragments] == [
        ids["creator"],
        ids["creator"],
    ]
    assert [fragment.updated_by_user_id for fragment in fragments] == [
        ids["editor"],
        ids["editor"],
    ]
    audit = db.scalar(
        select(AuditLog).where(AuditLog.action == "absence.day_removed")
    )
    assert audit.user_id == ids["editor"]
    assert audit.new_value_json["removed_date"] == "2026-11-04"

    outside = client.delete(f"/api/absences/{created['id']}/days/2026-10-31")
    assert outside.status_code == 400
    missing = client.delete("/api/absences/999999/days/2026-11-04")
    assert missing.status_code == 404
