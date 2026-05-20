from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.enums import SiteStatus
from app.models.site import Site
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.site import SiteCreate, SiteUpdate
from app.services.audit_service import AuditService


OPTIONAL_TEXT_FIELDS = ["site_number", "location", "address", "customer", "info", "color"]
CLOSED_STATUSES = {SiteStatus.CLOSED, SiteStatus.ARCHIVED}
OPEN_STATUSES = {SiteStatus.ACTIVE, SiteStatus.PAUSED}


class SiteService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.sites = SiteRepository(db)
        self.people = PersonRepository(db)
        self.audit = AuditService(db)

    def list_sites(self, include_closed: bool = False) -> list[Site]:
        return self.sites.list(include_closed=include_closed)

    def get_site(self, site_id: int) -> Site:
        site = self.sites.get(site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    def create_site(self, payload: SiteCreate, user_id: int) -> Site:
        values = clean_site_values(payload.model_dump())
        self._ensure_project_manager_exists(values.get("project_manager_person_id"))
        site = Site(**values)
        self._apply_status_metadata(site, site.status, user_id)
        self.sites.add(site)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="site.created",
            entity_type="site",
            entity_id=site.id,
            old_value=None,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def update_site(self, site_id: int, payload: SiteUpdate, user_id: int) -> Site:
        site = self.sites.get(site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")

        values = clean_site_values(payload.model_dump(exclude_unset=True))
        self._ensure_project_manager_exists(values.get("project_manager_person_id"))
        old_value = site_snapshot(site)
        status_value = values.get("status")
        if status_value is not None:
            self._apply_status_metadata(site, status_value, user_id)
        for field, value in values.items():
            setattr(site, field, value)
        self.audit.record(
            user_id=user_id,
            action="site.updated",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def close_site(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id)
        if site.status == SiteStatus.CLOSED:
            return site
        old_value = site_snapshot(site)
        site.status = SiteStatus.CLOSED
        self._apply_status_metadata(site, SiteStatus.CLOSED, user_id)
        self.audit.record(
            user_id=user_id,
            action="site.closed",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def reactivate_site(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id)
        if site.status == SiteStatus.ACTIVE and site.closed_at is None:
            return site
        old_value = site_snapshot(site)
        site.status = SiteStatus.ACTIVE
        self._apply_status_metadata(site, SiteStatus.ACTIVE, user_id)
        self.audit.record(
            user_id=user_id,
            action="site.reactivated",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def _apply_status_metadata(self, site: Site, status_value: SiteStatus, user_id: int) -> None:
        if status_value in CLOSED_STATUSES:
            if site.closed_at is None:
                site.closed_at = datetime.now(UTC)
            site.closed_by_user_id = user_id
        if status_value in OPEN_STATUSES:
            site.closed_at = None
            site.closed_by_user_id = None

    def _ensure_project_manager_exists(self, person_id: int | None) -> None:
        if person_id is not None and self.people.get(person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Projektleiter-Person nicht gefunden.")


def clean_site_values(values: dict) -> dict:
    cleaned = dict(values)
    if isinstance(cleaned.get("name"), str):
        cleaned["name"] = cleaned["name"].strip()
    for field in OPTIONAL_TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if "name" in cleaned and not cleaned.get("name"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustellenname darf nicht leer sein.")
    return cleaned


def site_snapshot(site: Site) -> dict:
    return {
        "id": site.id,
        "site_number": site.site_number,
        "name": site.name,
        "location": site.location,
        "address": site.address,
        "customer": site.customer,
        "project_manager_person_id": site.project_manager_person_id,
        "status": site.status.value,
        "info": site.info,
        "color": site.color,
        "closed_at": site.closed_at.isoformat() if site.closed_at else None,
        "closed_by_user_id": site.closed_by_user_id,
    }
