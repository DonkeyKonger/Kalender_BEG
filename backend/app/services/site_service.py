from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.enums import SiteStatus
from app.models.site import Site
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.site import SiteCreate, SiteUpdate


class SiteService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.sites = SiteRepository(db)
        self.people = PersonRepository(db)

    def list_sites(self, include_closed: bool = False) -> list[Site]:
        return self.sites.list(include_closed=include_closed)

    def create_site(self, payload: SiteCreate) -> Site:
        self._ensure_project_manager_exists(payload.project_manager_person_id)
        site = Site(**payload.model_dump())
        self.sites.add(site)
        self.db.commit()
        self.db.refresh(site)
        return site

    def update_site(self, site_id: int, payload: SiteUpdate, user_id: int) -> Site:
        site = self.sites.get(site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")

        values = payload.model_dump(exclude_unset=True)
        self._ensure_project_manager_exists(values.get("project_manager_person_id"))
        if values.get("status") in {SiteStatus.CLOSED, SiteStatus.ARCHIVED} and not site.closed_at:
            site.closed_at = datetime.now(UTC)
            site.closed_by_user_id = user_id
        for field, value in values.items():
            setattr(site, field, value)
        self.db.commit()
        self.db.refresh(site)
        return site

    def _ensure_project_manager_exists(self, person_id: int | None) -> None:
        if person_id is not None and self.people.get(person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Projektleiter-Person nicht gefunden.")
