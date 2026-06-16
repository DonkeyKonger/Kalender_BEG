from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, load_only, selectinload

from app.models.enums import SiteStatus
from app.models.person import Person
from app.models.site import Site


class SiteRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, site_id: int, *, include_deleted: bool = False) -> Site | None:
        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .where(Site.id == site_id)
        )
        if not include_deleted:
            statement = statement.where(Site.status != SiteStatus.DELETED)
        return self.db.scalar(statement)

    def list(
        self,
        include_closed: bool = False,
        project_manager_person_id: int | None = None,
    ) -> list[Site]:
        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .order_by(Site.name)
        )
        if project_manager_person_id is not None:
            statement = statement.where(
                Site.project_manager_person_id == project_manager_person_id
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
