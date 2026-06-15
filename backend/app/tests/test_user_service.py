from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.security import verify_password
from app.models.enums import UserRole
from app.schemas.user import UserCreate, UserPasswordReset, UserUpdate
from app.services.user_service import UserService


class FakeDb:
    def commit(self):
        raise AssertionError("commit should not be reached")

    def refresh(self, _item):
        raise AssertionError("refresh should not be reached")


class RecordingDb:
    def __init__(self):
        self.committed = False
        self.refreshed = None

    def commit(self):
        self.committed = True

    def refresh(self, item):
        self.refreshed = item


class FakeUsers:
    def __init__(self, *, by_id=None, by_username=None):
        self.by_id = by_id
        self.by_username = by_username

    def get_by_id(self, user_id):
        return self.by_id if self.by_id and self.by_id.id == user_id else None

    def get_by_username(self, username):
        return self.by_username if self.by_username and self.by_username.username == username else None


class FakePeople:
    def get(self, _person_id):
        return None


def service_with(*, user=None, username_user=None):
    service = UserService.__new__(UserService)
    service.db = FakeDb()
    service.users = FakeUsers(by_id=user, by_username=username_user)
    service.people = FakePeople()
    return service


def test_admin_cannot_disable_self():
    with pytest.raises(HTTPException) as error:
        service_with().disable_user(user_id=1, current_user_id=1)

    assert error.value.status_code == 400


def test_admin_cannot_delete_self():
    with pytest.raises(HTTPException) as error:
        service_with().delete_user(user_id=1, current_user_id=1)

    assert error.value.status_code == 400


def test_admin_cannot_remove_own_admin_role():
    user = SimpleNamespace(id=1, role=UserRole.ADMIN, is_active=True)

    with pytest.raises(HTTPException) as error:
        service_with(user=user).update_user(
            1,
            UserUpdate(role=UserRole.PROJECT_MANAGER),
            current_user_id=1,
        )

    assert error.value.status_code == 400


def test_last_active_admin_cannot_be_deleted():
    user = SimpleNamespace(id=2, role=UserRole.ADMIN, is_active=True)
    service = service_with(user=user)
    service._has_other_active_admin = lambda _user_id: False

    with pytest.raises(HTTPException) as error:
        service.delete_user(user_id=2, current_user_id=1)

    assert error.value.status_code == 400


def test_referenced_user_cannot_be_deleted():
    user = SimpleNamespace(id=2, role=UserRole.MONTEUR, is_active=True)
    service = service_with(user=user)
    service._user_has_references = lambda _user_id: True

    with pytest.raises(HTTPException) as error:
        service.delete_user(user_id=2, current_user_id=1)

    assert error.value.status_code == 409


def test_duplicate_username_is_blocked_on_create():
    existing = SimpleNamespace(id=5, username="admin")

    with pytest.raises(HTTPException) as error:
        service_with(username_user=existing).create_user(
            UserCreate(
                username="admin",
                display_name="Administrator",
                password="admin",
                role=UserRole.ADMIN,
            )
        )

    assert error.value.status_code == 409


def test_admin_password_reset_stores_last_admin_plain_password():
    user = SimpleNamespace(
        id=2,
        password_hash="old-hash",
        last_admin_password_plain="old-start",
        must_change_password=False,
    )
    db = RecordingDb()
    service = service_with(user=user)
    service.db = db

    service.reset_password(2, UserPasswordReset(password="NewStart123"))

    assert db.committed is True
    assert db.refreshed is user
    assert user.last_admin_password_plain == "NewStart123"
    assert user.must_change_password is True
    assert verify_password("NewStart123", user.password_hash)


def test_own_password_change_does_not_overwrite_last_admin_plain_password():
    user = SimpleNamespace(
        id=2,
        password_hash="old-hash",
        last_admin_password_plain="AdminStart123",
        must_change_password=True,
    )
    db = RecordingDb()
    service = service_with(user=user)
    service.db = db

    service.change_own_password(2, "OwnSecret123")

    assert db.committed is True
    assert db.refreshed is user
    assert user.last_admin_password_plain == "AdminStart123"
    assert user.must_change_password is False
    assert verify_password("OwnSecret123", user.password_hash)
