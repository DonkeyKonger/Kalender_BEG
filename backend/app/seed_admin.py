from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.user_repository import UserRepository


def seed_admin(db: Session) -> User:
    if not settings.admin_username or not settings.admin_password:
        raise RuntimeError("ADMIN_USERNAME und ADMIN_PASSWORD muessen gesetzt sein.")

    users = UserRepository(db)
    existing = users.get_by_username(settings.admin_username)
    if existing is not None:
        existing.display_name = settings.admin_display_name
        existing.password_hash = hash_password(settings.admin_password)
        existing.role = UserRole.ADMIN
        existing.is_active = True
        users.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    admin = User(
        username=settings.admin_username,
        display_name=settings.admin_display_name,
        password_hash=hash_password(settings.admin_password),
        role=UserRole.ADMIN,
        is_active=True,
    )
    users.add(admin)
    db.commit()
    db.refresh(admin)
    return admin


def main() -> None:
    with SessionLocal() as db:
        admin = seed_admin(db)
        print(f"Admin-Benutzer bereit: {admin.username}")


if __name__ == "__main__":
    main()
