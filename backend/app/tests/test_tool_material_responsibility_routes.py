from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.user import User


def add_office_user(
    db: Session,
    *,
    username: str,
    is_active: bool = True,
    person_type: PersonType = PersonType.INTERNAL,
    permissions: tuple[str, ...] = ("miscellaneous",),
) -> User:
    person = Person(
        first_name=username,
        last_name="Büro",
        display_name=f"{username} Büro",
        short_code=username[:8].upper(),
        person_type=person_type,
        is_active=True,
    )
    user = User(
        username=username,
        display_name=f"{username} Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=is_active,
        office_page_permissions=list(permissions),
        person=person,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def principal(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=900,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def test_responsibility_routes_enforce_read_and_admin_write_permissions():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    first = add_office_user(db, username="anna")
    second = add_office_user(db, username="berta")
    current = {"user": principal(UserRole.ADMIN)}
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    selected = client.put(
        "/api/admin/tool-material-items/responsibility",
        json={"tool_responsible_user_id": first.id},
    )
    assert selected.status_code == 200
    assert selected.json()["tool_responsible_user_id"] == first.id

    changed = client.put(
        "/api/admin/tool-material-items/responsibility",
        json={"tool_responsible_user_id": second.id},
    )
    assert changed.status_code == 200
    assert changed.json()["responsible_user"]["display_name"] == "berta Büro"

    current["user"] = principal(UserRole.OFFICE, "miscellaneous")
    office_read = client.get("/api/admin/tool-material-items/responsibility")
    office_write = client.put(
        "/api/admin/tool-material-items/responsibility",
        json={"tool_responsible_user_id": first.id},
    )
    office_options = client.get("/api/admin/tool-material-items/responsibility/options")
    assert office_read.status_code == 200
    assert office_read.json()["tool_responsible_user_id"] == second.id
    assert office_write.status_code == 403
    assert office_options.status_code == 403

    for role in (UserRole.PROJECT_MANAGER, UserRole.MONTEUR):
        current["user"] = principal(role, "miscellaneous")
        assert client.get("/api/admin/tool-material-items/responsibility").status_code == 403

    current["user"] = principal(UserRole.ADMIN)
    reset = client.put(
        "/api/admin/tool-material-items/responsibility",
        json={"tool_responsible_user_id": None},
    )
    assert reset.status_code == 200
    assert reset.json()["responsible_user"] is None
    app.dependency_overrides.clear()


def test_responsibility_api_only_offers_and_accepts_valid_office_users():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    valid = add_office_user(db, username="valid")
    inactive = add_office_user(db, username="inactive", is_active=False)
    external = add_office_user(db, username="external", person_type=PersonType.EXTERNAL)
    without_access = add_office_user(db, username="without-access", permissions=())
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: principal(UserRole.ADMIN)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    options = client.get("/api/admin/tool-material-items/responsibility/options")
    assert options.status_code == 200
    assert [option["id"] for option in options.json()] == [valid.id]

    for user_id in (inactive.id, external.id, without_access.id, 999_999):
        response = client.put(
            "/api/admin/tool-material-items/responsibility",
            json={"tool_responsible_user_id": user_id},
        )
        assert response.status_code == 400

    app.dependency_overrides.clear()
