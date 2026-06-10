from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Base
from app.models.enums import UserRole
from app.models.user import User
from app.seed_admin import seed_admin


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def configure_seed_admin(monkeypatch) -> None:
    monkeypatch.setattr(settings, "admin_username", "seed.admin")
    monkeypatch.setattr(settings, "admin_password", "temporary")
    monkeypatch.setattr(settings, "admin_display_name", "Seed Admin")


def test_seed_admin_does_not_reactivate_existing_inactive_admin(monkeypatch):
    configure_seed_admin(monkeypatch)
    db = db_session()
    existing = User(
        username="seed.admin",
        display_name="Inactive Admin",
        password_hash="old-hash",
        role=UserRole.ADMIN,
        is_active=False,
    )
    db.add(existing)
    db.commit()

    seeded = seed_admin(db)
    db.refresh(existing)

    assert seeded.id == existing.id
    assert existing.is_active is False
    assert existing.password_hash == "old-hash"
    assert existing.display_name == "Inactive Admin"


def test_seed_admin_does_not_recreate_seed_user_when_an_admin_exists(monkeypatch):
    configure_seed_admin(monkeypatch)
    db = db_session()
    existing_admin = User(
        username="real.admin",
        display_name="Real Admin",
        password_hash="real-hash",
        role=UserRole.ADMIN,
        is_active=True,
    )
    db.add(existing_admin)
    db.commit()

    seeded = seed_admin(db)
    users = list(db.scalars(select(User).order_by(User.username)))

    assert seeded.id == existing_admin.id
    assert [user.username for user in users] == ["real.admin"]
