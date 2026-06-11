from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketCreate, ExtraWorkTicketRead

EXTRA_WORK_SUBMITTABLE_STATUSES = {"draft"}
EXTRA_WORK_KINDS = {"billing", "approval"}
EXTRA_WORK_BILLING_KIND = "billing"
EXTRA_WORK_APPROVAL_KIND = "approval"


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
            kind=self._normalize_kind(payload.kind, default=EXTRA_WORK_BILLING_KIND),
            approval_ticket_id=self._validate_approval_ticket_id(site_id, payload.approval_ticket_id),
            status="draft",
            created_by_user_id=current_user.id,
            notes=payload.notes.strip() if payload.notes and payload.notes.strip() else None,
        )
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def list_mobile_tickets(
        self,
        *,
        assignment_id: int,
        current_user: User,
    ) -> list[ExtraWorkTicketRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        return self.list_site_tickets(assignment.site_id)

    def create_mobile_ticket(
        self,
        *,
        assignment_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate | None = None,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        site = self._get_site(assignment.site_id)
        requested = payload or ExtraWorkTicketCreate()
        default_kind = EXTRA_WORK_APPROVAL_KIND if site.requires_extra_work_approval else EXTRA_WORK_BILLING_KIND
        return self.create_site_ticket(
            site_id=assignment.site_id,
            current_user=current_user,
            payload=ExtraWorkTicketCreate(
                title=requested.title,
                kind=requested.kind or default_kind,
                approval_ticket_id=requested.approval_ticket_id,
                notes=requested.notes,
            ),
        )

    def get_mobile_ticket(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        return ExtraWorkTicketRead.model_validate(ticket)

    def submit_mobile_ticket(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.status not in EXTRA_WORK_SUBMITTABLE_STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Stundenzettel kann nicht zur Prüfung gesendet werden.")
        ticket.status = "submitted"
        ticket.submitted_by_user_id = current_user.id
        ticket.submitted_at = datetime.now(UTC)
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def update_mobile_ticket_status(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        next_status: str,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        if next_status != "submitted":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status wird für mobile Stundenzettel noch nicht unterstützt.")
        return self.submit_mobile_ticket(
            assignment_id=assignment_id,
            ticket_id=ticket_id,
            current_user=current_user,
        )

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )
        assignment = self.db.scalar(
            select(Assignment).where(
                Assignment.id == assignment_id,
                Assignment.person_id == current_user.person_id,
            )
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        return assignment

    def _get_ticket_for_site(self, ticket_id: int, site_id: int) -> ExtraWorkTicket:
        ticket = self.db.scalar(
            select(ExtraWorkTicket).where(
                ExtraWorkTicket.id == ticket_id,
                ExtraWorkTicket.site_id == site_id,
            )
        )
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    def _validate_approval_ticket_id(self, site_id: int, approval_ticket_id: int | None) -> int | None:
        if approval_ticket_id is None:
            return None
        approval_ticket = self._get_ticket_for_site(approval_ticket_id, site_id)
        if approval_ticket.kind != EXTRA_WORK_APPROVAL_KIND:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Verknüpfte Freigabe muss eine Stundenfreigabe sein.")
        return approval_ticket.id

    @staticmethod
    def _normalize_kind(value: str | None, *, default: str) -> str:
        normalized = value.strip().lower() if isinstance(value, str) else ""
        kind = normalized or default
        if kind not in EXTRA_WORK_KINDS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unbekannte Stundenzettel-Prozessart.")
        return kind

    @staticmethod
    def _build_display_number(site: Site, sequence_number: int) -> str:
        clean_site_number = site.site_number.strip() if site.site_number else ""
        if clean_site_number:
            return f"{clean_site_number}.SZ{sequence_number:02d}"
        return f"Stundenzettel {sequence_number}"
