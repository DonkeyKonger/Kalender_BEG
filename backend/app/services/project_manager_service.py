from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.user import User


PROJECT_MANAGER_USER_ROLES = (UserRole.ADMIN, UserRole.PROJECT_MANAGER)


class ProjectManagerService:
    """Central source of truth for active project-manager people."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def list_active_project_managers(self) -> list[Person]:
        return list(self.db.scalars(active_project_manager_statement()))

    def get_active_project_manager(self, person_id: int) -> Person | None:
        return self.db.scalar(
            active_project_manager_statement().where(Person.id == person_id)
        )


def active_project_manager_statement():
    return (
        select(Person)
        .join(User, User.person_id == Person.id)
        .where(
            User.is_active.is_(True),
            User.role.in_(PROJECT_MANAGER_USER_ROLES),
            Person.is_active.is_(True),
            Person.deleted_at.is_(None),
            Person.person_type == PersonType.INTERNAL,
        )
        .distinct()
        .order_by(Person.display_name, Person.id)
    )
