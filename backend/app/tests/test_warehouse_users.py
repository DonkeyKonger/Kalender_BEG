import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.core.security import hash_password
from app.main import create_app
from app.models import Base, Person, User
from app.models.enums import UserRole
from app.schemas.user import UserCreate, UserPasswordReset, UserUpdate
from app.services.auth_service import AuthService
from app.services.user_service import UserService


@pytest.fixture
def account_env():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        admin = User(username="admin-test", display_name="Admin", role=UserRole.ADMIN,
                     password_hash=hash_password("admin-test-only"), must_change_password=False)
        db.add(admin)
        db.commit()
        app = create_app()
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)
        headers = {"Authorization": f"Bearer {AuthService(db).create_user_token(admin)}"}
        yield db, client, headers
        client.close()
    engine.dispose()


def create_warehouse(client, headers, **extra):
    return client.post("/api/users", headers=headers, json={
        "username": "lager-test", "display_name": "Lager", "password": "lager-test-only",
        "role": "warehouse", **extra,
    })


def test_admin_creates_warehouse_and_initial_login_and_refresh_need_no_password_change(account_env):
    db, client, headers = account_env
    created = create_warehouse(client, headers, office_page_permissions=["payroll"])
    assert created.status_code == 201, created.text
    assert created.json()["person_id"] is None
    assert created.json()["office_page_permissions"] == []
    assert created.json()["must_change_password"] is False
    login = client.post("/api/auth/login", json={"username": "lager-test", "password": "lager-test-only"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is False
    warehouse_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    me = client.get("/api/auth/me", headers=warehouse_headers)
    assert me.status_code == 200
    assert me.json()["role"] == "warehouse"
    assert me.json()["person_id"] is None
    assert me.json()["must_change_password"] is False
    refresh = client.post("/api/auth/refresh", headers=warehouse_headers)
    assert refresh.status_code == 200
    assert refresh.json()["must_change_password"] is False
    assert db.get(User, created.json()["id"]).last_login_at is not None


def test_warehouse_reset_password_is_immediately_usable_and_disable_blocks_login(account_env):
    db, client, headers = account_env
    user_id = create_warehouse(client, headers).json()["id"]
    reset = client.post(f"/api/users/{user_id}/reset-password", headers=headers, json={"password": "new-lager-only"})
    assert reset.status_code == 200
    assert reset.json()["must_change_password"] is False
    assert client.post("/api/auth/login", json={"username": "lager-test", "password": "lager-test-only"}).status_code == 401
    login = client.post("/api/auth/login", json={"username": "lager-test", "password": "new-lager-only"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is False
    warehouse_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.post(f"/api/users/{user_id}/disable", headers=headers).status_code == 200
    assert client.post("/api/auth/login", json={"username": "lager-test", "password": "new-lager-only"}).status_code == 403
    assert client.get("/api/auth/me", headers=warehouse_headers).status_code == 403
    assert client.post("/api/auth/refresh", headers=warehouse_headers).status_code == 403


def test_warehouse_person_link_is_rejected_in_create_update_and_database(account_env):
    db, client, headers = account_env
    person = Person(first_name="Test", last_name="Person", display_name="Test Person", short_code="TP")
    db.add(person)
    db.commit()
    assert create_warehouse(client, headers, person_id=person.id).status_code == 400
    user_id = create_warehouse(client, headers).json()["id"]
    assert client.patch(f"/api/users/{user_id}", headers=headers, json={"person_id": person.id}).status_code == 400
    assert db.get(User, user_id).person_id is None
    with pytest.raises(IntegrityError), db.begin_nested():
        db.get(User, user_id).person_id = person.id
        db.flush()


def test_conversion_to_warehouse_detaches_person_and_password_exception_does_not_leak(account_env):
    db, client, headers = account_env
    person = Person(first_name="Test", last_name="Person", display_name="Test Person", short_code="TP")
    db.add(person)
    db.commit()
    service = UserService(db)
    user = service.create_user(UserCreate(username="office-test", display_name="Office", password="office-test-only",
                                         role=UserRole.OFFICE, person_id=person.id, office_page_permissions=["payroll"]))
    service.update_user(user.id, UserUpdate(role=UserRole.WAREHOUSE), current_user_id=1)
    assert user.person_id is None
    assert user.office_page_permissions == []
    assert user.must_change_password is False
    service.update_user(user.id, UserUpdate(role=UserRole.MONTEUR), current_user_id=1)
    assert user.must_change_password is True


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR])
def test_existing_roles_keep_required_password_change_on_creation_and_reset(account_env, role):
    db, _, _ = account_env
    service = UserService(db)
    user = service.create_user(UserCreate(username="existing-role", display_name="Test", password="test-only",
                                         role=role))
    assert user.must_change_password is True
    service.change_own_password(user.id, "own-password")
    assert user.must_change_password is False
    service.reset_password(user.id, UserPasswordReset(password="reset-password"))
    assert user.must_change_password is True


def test_warehouse_cannot_access_any_existing_business_or_mobile_api(account_env):
    db, client, headers = account_env
    user_id = create_warehouse(client, headers).json()["id"]
    warehouse_headers = {"Authorization": f"Bearer {AuthService(db).create_user_token(db.get(User, user_id))}"}
    checked = 0
    for route in client.app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api/"):
            continue
        if route.path.startswith(("/api/auth/", "/api/health", "/api/warehouse/")):
            continue
        path = re.sub(r"\{[^}]+\}", "1", route.path)
        for method in route.methods:
            response = client.request(method, path, headers=warehouse_headers, json={})
            assert response.status_code == 403, (method, path, response.status_code, response.text)
            checked += 1
    assert checked > 100
