from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketCreate, ExtraWorkTicketRead


class ExtraWorkService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_site_tickets(self, site_id: int) -> list[ExtraWorkTicketRead]:
        self._get_site(site_id)
        tickets = list(
            self.db.scalars(
                select(ExtraWorkTicket)
                .where(ExtraWorkTicket.site_id == site_id)
                .order_by(ExtraWorkTicket.sequence_number, ExtraWorkTicket.id)
            ).all()
        )
        return [ExtraWorkTicketRead.model_validate(ticket) for ticket in tickets]

    def create_site_ticket(
        self,
        *,
        site_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate,
    ) -> ExtraWorkTicketRead:
        site = self._get_site(site_id)
        next_sequence = (
            self.db.scalar(
                select(func.max(ExtraWorkTicket.sequence_number)).where(
                    ExtraWorkTicket.site_id == site_id
                )
            )
            or 0
        ) + 1
        ticket = ExtraWorkTicket(
            site_id=site_id,
            sequence_number=next_sequence,
            display_number=self._build_display_number(site, next_sequence),
            title=payload.title.strip() if payload.title and payload.title.strip() else None,
            status="draft",
            created_by_user_id=current_user.id,
            notes=payload.notes.strip() if payload.notes and payload.notes.strip() else None,
        )
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    @staticmethod
    def _build_display_number(site: Site, sequence_number: int) -> str:
        clean_site_number = site.site_number.strip() if site.site_number else ""
        if clean_site_number:
            return f"{clean_site_number}.SZ{sequence_number:02d}"
        return f"Stundenzettel {sequence_number}"
