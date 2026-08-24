from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.user import User


def get_mobile_extra_work_assignment(
    db: Session,
    assignment_id: int,
    current_user: User,
) -> Assignment:
    """Resolve a mobile extra-work assignment owned by the current user."""
    if current_user.person_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Dieser Benutzer ist keiner Person zugeordnet.",
        )
    assignment = db.scalar(
        select(Assignment)
        .options(selectinload(Assignment.person))
        .where(
            Assignment.id == assignment_id,
            Assignment.person_id == current_user.person_id,
        )
    )
    if assignment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
    return assignment
