from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, load_only, selectinload

from app.models.enums import SiteStatus
from app.models.person import Person
from app.models.site import Site


class SiteRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, site_id: int) -> Site | None:
        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .where(Site.id == site_id)
        )
        return self.db.scalar(statement)

    def list(self, include_closed: bool = False) -> list[Site]:
        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .order_by(Site.name)
        )
        if not include_closed:
            statement = statement.where(
                Site.status.not_in([SiteStatus.COMPLETED, SiteStatus.DELETED])
            )
        return list(self.db.scalars(statement))

    def list_summary(self, include_closed: bool = False) -> list[Site]:
        statement = (
            select(Site)
            .options(
                load_only(
                    Site.id,
                    Site.site_number,
                    Site.name,
                    Site.location,
                    Site.city,
                    Site.customer,
                    Site.project_manager_person_id,
                    Site.status,
                    Site.color,
                ),
                selectinload(Site.project_manager).load_only(
                    Person.id,
                    Person.display_name,
                    Person.short_code,
                ),
            )
            .order_by(Site.name)
        )
        if not include_closed:
            statement = statement.where(
                Site.status.not_in([SiteStatus.COMPLETED, SiteStatus.DELETED])
            )
        return list(self.db.scalars(statement))

    def add(self, site: Site) -> Site:
        self.db.add(site)
        self.db.flush()
        return site
