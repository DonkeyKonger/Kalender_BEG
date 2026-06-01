from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.enums import UserRole
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
from app.models.user import User
from app.repositories.person_repository import PersonRepository
from app.repositories.user_repository import UserRepository
from app.schemas.user import UserCreate, UserPasswordReset, UserUpdate


class UserService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.people = PersonRepository(db)

    def list_users(self) -> list[User]:
        return self.users.list_users()

    def create_user(self, payload: UserCreate) -> User:
        username = clean_username(payload.username)
        self._ensure_username_available(username)
        self._ensure_person_exists(payload.person_id)

        user = User(
            username=username,
            display_name=clean_display_name(payload.display_name),
            password_hash=hash_password(payload.password),
            role=payload.role,
            is_active=payload.is_active,
            person_id=payload.person_id,
        )
        self.users.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def update_user(self, user_id: int, payload: UserUpdate, current_user_id: int) -> User:
        user = self._get_user(user_id)
        values = payload.model_dump(exclude_unset=True)

        if "username" in values and values["username"] is not None:
            username = clean_username(values["username"])
            self._ensure_username_available(username, ignore_user_id=user_id)
            user.username = username
        if "display_name" in values and values["display_name"] is not None:
            user.display_name = clean_display_name(values["display_name"])
        if "role" in values and values["role"] is not None:
            if user.id == current_user_id and values["role"] != UserRole.ADMIN:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Die eigene Admin-Rolle kann nicht entfernt werden.",
                )
            user.role = values["role"]
        if "is_active" in values and values["is_active"] is not None:
            if user.id == current_user_id and values["is_active"] is False:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Der eigene Benutzer kann nicht deaktiviert werden.",
                )
            user.is_active = values["is_active"]
        if "person_id" in values:
            self._ensure_person_exists(values["person_id"])
            user.person_id = values["person_id"]

        self.db.commit()
        self.db.refresh(user)
        return user

    def reset_password(self, user_id: int, payload: UserPasswordReset) -> User:
        user = self._get_user(user_id)
        user.password_hash = hash_password(payload.password)
        self.db.commit()
        self.db.refresh(user)
        return user

    def disable_user(self, user_id: int, current_user_id: int) -> User:
        if user_id == current_user_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Der eigene Benutzer kann nicht deaktiviert werden.",
            )
        user = self._get_user(user_id)
        user.is_active = False
        self.db.commit()
        self.db.refresh(user)
        return user

    def delete_user(self, user_id: int, current_user_id: int) -> None:
        if user_id == current_user_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Der eigene Benutzer kann nicht geloescht werden.",
            )
        user = self._get_user(user_id)
        if user.role == UserRole.ADMIN and not self._has_other_active_admin(user.id):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Der letzte aktive Admin kann nicht geloescht werden.",
            )
        if self._user_has_references(user.id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Kann nicht geloescht werden, weil der Eintrag noch verwendet wird.",
            )

        self.db.delete(user)
        self.db.commit()

    def _get_user(self, user_id: int) -> User:
        user = self.users.get_by_id(user_id)
        if user is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Benutzer nicht gefunden.")
        return user

    def _ensure_username_available(
        self,
        username: str,
        *,
        ignore_user_id: int | None = None,
    ) -> None:
        existing = self.users.get_by_username(username)
        if existing is not None and existing.id != ignore_user_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Anmeldename ist bereits vergeben.")

    def _ensure_person_exists(self, person_id: int | None) -> None:
        if person_id is not None and self.people.get(person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")

    def _has_other_active_admin(self, user_id: int) -> bool:
        statement = (
            select(User.id)
            .where(
                User.id != user_id,
                User.role == UserRole.ADMIN,
                User.is_active.is_(True),
            )
            .limit(1)
        )
        return self.db.scalar(statement) is not None

    def _user_has_references(self, user_id: int) -> bool:
        return (
            self._has_row(Assignment, Assignment.created_by_user_id == user_id)
            or self._has_row(Assignment, Assignment.updated_by_user_id == user_id)
            or self._has_row(Absence, Absence.created_by_user_id == user_id)
            or self._has_row(Absence, Absence.updated_by_user_id == user_id)
            or self._has_row(Site, Site.closed_by_user_id == user_id)
            or self._has_row(SiteMeasurementBatch, SiteMeasurementBatch.created_by_user_id == user_id)
            or self._has_row(SiteMeasurementBatch, SiteMeasurementBatch.submitted_by_user_id == user_id)
            or self._has_row(SiteMeasurementEntry, SiteMeasurementEntry.created_by_user_id == user_id)
            or self._has_row(PlanningCellMark, PlanningCellMark.created_by_user_id == user_id)
            or self._has_row(PlanningCellMark, PlanningCellMark.updated_by_user_id == user_id)
            or self._has_row(AuditLog, AuditLog.user_id == user_id)
        )

    def _has_row(self, model, *criteria) -> bool:
        statement = select(model.id).where(*criteria).limit(1)
        return self.db.scalar(statement) is not None


def clean_username(username: str) -> str:
    cleaned = username.strip()
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Anmeldename darf nicht leer sein.")
    return cleaned


def clean_display_name(display_name: str) -> str:
    cleaned = display_name.strip()
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Anzeigename darf nicht leer sein.")
    return cleaned
