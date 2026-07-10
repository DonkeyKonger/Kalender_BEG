import re
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.enums import SiteStatus
from app.models.dashboard_note import DashboardNote
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.dashboard_note import DashboardNoteCreate, DashboardNoteUpdate


DASHBOARD_NOTE_SITE_STATUSES = (SiteStatus.ACTIVE, SiteStatus.PAUSED, SiteStatus.PLANNED)


class DashboardNoteService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_notes(self, *, user_id: int, completed: bool | None = None) -> list[DashboardNote]:
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
        statement = statement.order_by(
            DashboardNote.completed.asc(),
            DashboardNote.due_date.is_(None),
            DashboardNote.due_date.asc(),
            DashboardNote.updated_at.desc(),
            DashboardNote.id.desc(),
        )
        return list(self.db.scalars(statement))

    def list_site_options(self, *, user: User) -> list[Site]:
        if user.person_id is None:
            return []

        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .where(
                Site.project_manager_person_id == user.person_id,
                Site.status.in_(DASHBOARD_NOTE_SITE_STATUSES),
            )
        )
        return sorted(self.db.scalars(statement), key=site_number_sort_key)

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
        self._ensure_references_exist(values.get("site_id"), values.get("employee_id"))
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

    def _ensure_references_exist(self, site_id: int | None, employee_id: int | None) -> None:
        if site_id is not None and self.db.get(Site, site_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustelle nicht gefunden.")
        if employee_id is not None:
            employee = self.db.get(Person, employee_id)
            if employee is None or employee.deleted_at is not None:
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
