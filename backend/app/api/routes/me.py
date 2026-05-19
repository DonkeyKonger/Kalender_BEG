from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.schemas.mobile import MobileAssignmentsResponse
from app.services.mobile_assignment_service import MobileAssignmentService

router = APIRouter(prefix="/me", tags=["me"])


@router.get("/assignments", response_model=MobileAssignmentsResponse)
def list_my_assignments(
    start: date,
    end: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileAssignmentsResponse:
    return MobileAssignmentService(db).list_own_assignments(
        current_user=current_user,
        start=start,
        end=end,
    )


@router.get("/assignments/history", response_model=MobileAssignmentsResponse)
def list_my_assignment_history(
    start: date,
    end: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileAssignmentsResponse:
    return MobileAssignmentService(db).list_own_assignments(
        current_user=current_user,
        start=start,
        end=end,
        allow_history=True,
    )
