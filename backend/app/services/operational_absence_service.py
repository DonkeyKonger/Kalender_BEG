from datetime import date, time

from fastapi import HTTPException, status
from sqlalchemy import case, select
from sqlalchemy.orm import Session, selectinload

from app.models.enums import SiteStatus
from app.models.operational_absence import OperationalAbsence
from app.models.person import Person
from app.models.site import Site
from app.repositories.site_repository import SiteRepository
from app.schemas.operational_absence import (
    OperationalAbsenceCreate,
    validate_operational_absence_times,
)
from app.services.audit_service import AuditService
from app.services.dashboard_note_service import site_number_sort_key
from app.services.project_manager_service import ProjectManagerService


MAX_OPERATIONAL_ABSENCE_RANGE_DAYS = 366


class OperationalAbsenceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.audit = AuditService(db)
        self.project_managers = ProjectManagerService(db)
        self.sites = SiteRepository(db)

    def list_operational_absences(
        self,
        *,
        start: date,
        end: date,
    ) -> list[OperationalAbsence]:
        validate_operational_absence_range(start=start, end=end)
        statement = (
            select(OperationalAbsence)
            .join(
                Person,
                Person.id == OperationalAbsence.project_manager_id,
            )
            .options(
                selectinload(OperationalAbsence.project_manager),
                selectinload(OperationalAbsence.site),
            )
            .where(
                OperationalAbsence.absence_date >= start,
                OperationalAbsence.absence_date <= end,
            )
            .order_by(
                OperationalAbsence.absence_date,
                case((OperationalAbsence.start_time.is_(None), 1), else_=0),
                OperationalAbsence.start_time,
                Person.display_name,
                OperationalAbsence.id,
            )
        )
        return list(self.db.scalars(statement))

    def list_project_manager_options(self) -> list[Person]:
        return self.project_managers.list_active_project_managers()

    def list_site_options(self) -> list[Site]:
        return sorted(self.sites.list_summary(), key=site_number_sort_key)

    def create_operational_absence(
        self,
        payload: OperationalAbsenceCreate,
        *,
        user_id: int,
    ) -> OperationalAbsence:
        validate_operational_absence_times(payload.start_time, payload.end_time)
        self._ensure_project_manager(payload.project_manager_id)
        self._ensure_site(payload.site_id)
        entry = OperationalAbsence(
            project_manager_id=payload.project_manager_id,
            absence_date=payload.date,
            start_time=payload.start_time,
            end_time=payload.end_time,
            site_id=payload.site_id,
            text=clean_operational_absence_text(payload.text),
            created_by_user_id=user_id,
        )
        self.db.add(entry)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="operational_absence.created",
            entity_type="operational_absence",
            entity_id=entry.id,
            old_value=None,
            new_value=operational_absence_snapshot(entry),
        )
        self.db.commit()
        return self.get_operational_absence(entry.id)

    def delete_operational_absence(self, entry_id: int, *, user_id: int) -> None:
        entry = self.get_operational_absence(entry_id)
        snapshot = operational_absence_snapshot(entry)
        self.db.delete(entry)
        self.audit.record(
            user_id=user_id,
            action="operational_absence.deleted",
            entity_type="operational_absence",
            entity_id=entry_id,
            old_value=snapshot,
            new_value=None,
        )
        self.db.commit()

    def get_operational_absence(self, entry_id: int) -> OperationalAbsence:
        entry = self.db.scalar(
            select(OperationalAbsence)
            .options(
                selectinload(OperationalAbsence.project_manager),
                selectinload(OperationalAbsence.site),
            )
            .where(OperationalAbsence.id == entry_id)
        )
        if entry is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Betriebliche Abwesenheit nicht gefunden.",
            )
        return entry

    def _ensure_project_manager(self, person_id: int) -> None:
        if self.project_managers.get_active_project_manager(person_id) is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Projektleiter nicht gefunden oder nicht aktiv.",
            )

    def _ensure_site(self, site_id: int | None) -> None:
        if site_id is None:
            return
        site = self.sites.get(site_id, include_deleted=True)
        if site is None or site.status in {SiteStatus.COMPLETED, SiteStatus.DELETED}:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Baustelle nicht gefunden oder nicht auswählbar.",
            )


def validate_operational_absence_range(*, start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
    if (end - start).days + 1 > MAX_OPERATIONAL_ABSENCE_RANGE_DAYS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Zeitraum für betriebliche Abwesenheiten ist zu groß.",
        )


def clean_operational_absence_text(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip() or None


def operational_absence_snapshot(entry: OperationalAbsence) -> dict:
    return {
        "id": entry.id,
        "project_manager_id": entry.project_manager_id,
        "date": entry.absence_date.isoformat(),
        "start_time": time_token(entry.start_time),
        "end_time": time_token(entry.end_time),
        "site_id": entry.site_id,
        "text": entry.text,
        "created_by_user_id": entry.created_by_user_id,
    }


def time_token(value: time | None) -> str | None:
    return value.isoformat(timespec="minutes") if value is not None else None
