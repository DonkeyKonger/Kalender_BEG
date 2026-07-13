import re
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.dashboard_note import DashboardNote
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.site import Site
from app.repositories.site_repository import SiteRepository
from app.schemas.dashboard_note import DashboardNoteCreate, DashboardNoteUpdate
from app.services.person_service import PersonService


class DashboardNoteService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.people = PersonService(db)
        self.sites = SiteRepository(db)

    def list_notes(
        self,
        *,
        user_id: int,
        completed: bool | None = None,
        site_id: int | None = None,
    ) -> list[DashboardNote]:
        statement = (
            select(DashboardNote)
            .options(selectinload(DashboardNote.site), selectinload(DashboardNote.employee))
            .where(
                DashboardNote.created_by_user_id == user_id,
                DashboardNote.deleted_at.is_(None),
            )
        )
        if completed is not None:
            statement = statement.where(DashboardNote.completed.is_(completed))
        if site_id is not None:
            statement = statement.where(DashboardNote.site_id == site_id)
        statement = statement.order_by(
            DashboardNote.completed.asc(),
            DashboardNote.due_date.is_(None),
            DashboardNote.due_date.asc(),
            DashboardNote.updated_at.desc(),
            DashboardNote.id.desc(),
        )
        return list(self.db.scalars(statement))

    def list_site_options(self) -> list[Site]:
        return sorted(self.sites.list_summary(), key=site_number_sort_key)

    def list_employee_options(self) -> list[Person]:
        return sorted(
            (
                person
                for person in self.people.list_people(is_active=True)
                if is_assignable_note_employee(person)
            ),
            key=employee_name_sort_key,
        )

    def create_note(self, payload: DashboardNoteCreate, user_id: int) -> DashboardNote:
        values = clean_note_values(payload.model_dump())
        self._ensure_references_exist(values.get("site_id"), values.get("employee_id"))
        note = DashboardNote(**values, created_by_user_id=user_id)
        self.db.add(note)
        self.db.commit()
        self.db.refresh(note)
        return self._get_note(note.id, user_id=user_id) or note

    def update_note(self, note_id: int, payload: DashboardNoteUpdate, *, user_id: int) -> DashboardNote:
        note = self._get_note(note_id, user_id=user_id)
        if note is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Notiz nicht gefunden.")

        values = clean_note_values(payload.model_dump(exclude_unset=True), partial=True)
        self._ensure_references_exist(
            values.get("site_id"),
            values.get("employee_id"),
            existing_employee_id=note.employee_id,
        )
        completed_changed = "completed" in values and values["completed"] != note.completed

        for field, value in values.items():
            if field == "completed":
                continue
            setattr(note, field, value)
        if completed_changed:
            note.completed = values["completed"]
            note.completed_at = datetime.now(timezone.utc) if note.completed else None

        self.db.commit()
        self.db.refresh(note)
        return self._get_note(note.id, user_id=user_id) or note

    def delete_note(self, note_id: int, user_id: int) -> None:
        note = self._get_note(note_id, user_id=user_id)
        if note is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Notiz nicht gefunden.")
        note.deleted_at = datetime.now(timezone.utc)
        note.deleted_by_user_id = user_id
        self.db.commit()

    def _get_note(self, note_id: int, *, user_id: int) -> DashboardNote | None:
        return self.db.scalar(
            select(DashboardNote)
            .options(selectinload(DashboardNote.site), selectinload(DashboardNote.employee))
            .where(
                DashboardNote.id == note_id,
                DashboardNote.created_by_user_id == user_id,
                DashboardNote.deleted_at.is_(None),
            )
        )

    def _ensure_references_exist(
        self,
        site_id: int | None,
        employee_id: int | None,
        *,
        existing_employee_id: int | None = None,
    ) -> None:
        if site_id is not None and self.db.get(Site, site_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustelle nicht gefunden.")
        if employee_id is not None:
            employee = self.db.get(Person, employee_id)
            if employee is None or (
                employee.deleted_at is not None and employee_id != existing_employee_id
            ):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mitarbeiter nicht gefunden.")


def clean_note_values(values: dict, *, partial: bool = False) -> dict:
    cleaned = dict(values)
    if cleaned.get("completed") is None:
        cleaned.pop("completed", None)
    if "text" in cleaned and isinstance(cleaned["text"], str):
        cleaned["text"] = cleaned["text"].strip()
    if not partial and not cleaned.get("text"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Notiztext darf nicht leer sein.")
    if "text" in cleaned and not cleaned.get("text"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Notiztext darf nicht leer sein.")
    return cleaned


def site_number_sort_key(site: Site) -> tuple[bool, tuple[tuple[int, int | str], ...], str, int]:
    site_number = (site.site_number or "").strip()
    parts = tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", site_number)
        if part
    )
    return (not site_number, parts, site.name.casefold(), site.id)


def is_assignable_note_employee(person: Person) -> bool:
    if not person.is_active or person.deleted_at is not None:
        return False
    linked_users = list(person.users)
    if linked_users and not any(user.is_active for user in linked_users):
        return False
    if person.person_type in {PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP}:
        return True
    if not linked_users:
        return True
    return any(user.is_active and user.role == UserRole.MONTEUR for user in linked_users)


def employee_name_sort_key(person: Person) -> tuple[str, str, str, int]:
    return (
        person.last_name.casefold(),
        person.first_name.casefold(),
        person.display_name.casefold(),
        person.id,
    )
