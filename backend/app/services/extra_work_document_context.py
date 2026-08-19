from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.enums import UserRole
from app.services.extra_work_dates import (
    ExtraWorkDocumentDates,
    resolve_extra_work_document_dates,
)


def get_extra_work_assignment_context(
    db: Session,
    ticket: ExtraWorkTicket,
) -> Assignment | None:
    """Resolve the assignment context shared by the desktop sheet and final PDF."""
    person_id = ticket.created_by.person_id if ticket.created_by else None
    if ticket.created_by is not None:
        if ticket.created_by.role != UserRole.MONTEUR or person_id is None:
            return None
    statement = (
        select(Assignment)
        .options(selectinload(Assignment.person))
        .where(Assignment.site_id == ticket.site_id)
    )
    if person_id is not None:
        statement = statement.where(Assignment.person_id == person_id)
    return db.scalar(
        statement.order_by(
            Assignment.start_date.desc(),
            Assignment.id.desc(),
        ).limit(1)
    )


def resolve_extra_work_ticket_dates(
    ticket: ExtraWorkTicket,
    assignment: Assignment | None,
) -> ExtraWorkDocumentDates:
    return resolve_extra_work_document_dates(
        created_at=ticket.created_at,
        assignment_start_date=assignment.start_date if assignment else None,
        manual_order_date=ticket.manual_order_date,
        manual_execution_week=ticket.manual_execution_week,
        manual_execution_week_year=ticket.manual_execution_week_year,
        manual_execution_start=ticket.manual_execution_start,
        manual_execution_end=ticket.manual_execution_end,
    )


def resolve_extra_work_approval_place(ticket: ExtraWorkTicket) -> str | None:
    return ticket.site.city or ticket.site.location or None
