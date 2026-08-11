from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User


def add_user(
    db: Session,
    *,
    username: str,
    role: UserRole,
    permissions: tuple[str, ...] = (),
) -> User:
    person = Person(
        first_name=username,
        last_name="Person",
        display_name=f"{username} Person",
        short_code=username[:3].upper(),
    )
    user = User(
        username=username,
        display_name=person.display_name,
        password_hash="x",
        role=role,
        is_active=True,
        office_page_permissions=list(permissions),
        person=person,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_all_authenticated_roles_can_create_and_delete_operational_absences():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    manager = add_user(db, username="manager", role=UserRole.PROJECT_MANAGER)
    users = [
        add_user(db, username="admin", role=UserRole.ADMIN),
        add_user(
            db,
            username="office",
            role=UserRole.OFFICE,
            permissions=("calendar",),
        ),
        add_user(db, username="office-no-calendar", role=UserRole.OFFICE),
        manager,
        add_user(db, username="worker", role=UserRole.MONTEUR),
    ]
    current = {"user": users[0]}
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    project_manager_options = client.get(
        "/api/operational-absences/project-manager-options"
    )
    assert project_manager_options.status_code == 200
    assert manager.person_id in [item["id"] for item in project_manager_options.json()]
    assert set(project_manager_options.json()[0]) == {
        "id",
        "display_name",
        "short_code",
    }

    site = Site(site_number="8015", name="FFW Barmbek", status=SiteStatus.ACTIVE)
    db.add(site)
    db.commit()
    site_options = client.get("/api/operational-absences/site-options")
    assert site_options.status_code == 200
    assert site_options.json() == [
        {"id": site.id, "site_number": "8015", "name": "FFW Barmbek"}
    ]

    for index, user in enumerate(users, start=11):
        current["user"] = user
        created = client.post(
            "/api/operational-absences",
            json={
                "project_manager_id": manager.person_id,
                "date": f"2026-08-{index:02d}",
                "start_time": None,
                "end_time": None,
                "site_id": None,
                "text": None,
            },
        )
        assert created.status_code == 201
        assert created.json()["project_manager_id"] == manager.person_id
        assert created.json()["date"] == f"2026-08-{index:02d}"

        listed = client.get(
            "/api/operational-absences",
            params={"start": date(2026, 8, index), "end": date(2026, 8, index)},
        )
        can_read_matrix = user.role in {UserRole.ADMIN, UserRole.PROJECT_MANAGER} or (
            user.role == UserRole.OFFICE
            and "calendar" in (user.office_page_permissions or [])
        )
        if can_read_matrix:
            assert listed.status_code == 200
            assert [item["id"] for item in listed.json()] == [created.json()["id"]]
        else:
            assert listed.status_code == 403

        deleted = client.delete(
            f"/api/operational-absences/{created.json()['id']}"
        )
        assert deleted.status_code == 204

    current["user"] = users[1]
    invalid_target = client.post(
        "/api/operational-absences",
        json={
            "project_manager_id": users[-1].person_id,
            "date": "2026-08-20",
        },
    )
    assert invalid_target.status_code == 400

    invalid_time = client.post(
        "/api/operational-absences",
        json={
            "project_manager_id": manager.person_id,
            "date": "2026-08-20",
            "start_time": "09:00",
        },
    )
    assert invalid_time.status_code == 422
    app.dependency_overrides.clear()
