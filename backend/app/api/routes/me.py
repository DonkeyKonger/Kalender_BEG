from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.schemas.measurement import (
    MeasurementEntryCreate,
    MeasurementEntryRead,
    MobileMeasurementItemRead,
)
from app.schemas.mobile import MobileAssignmentsResponse
from app.services.measurement_service import MeasurementService
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


@router.get(
    "/assignments/{assignment_id}/measurement-items",
    response_model=list[MobileMeasurementItemRead],
)
def list_my_assignment_measurement_items(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementItemRead]:
    return MeasurementService(db).list_mobile_items(
        assignment_id=assignment_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-items/{measurement_item_id}/entries",
    response_model=MeasurementEntryRead,
)
def create_my_assignment_measurement_entry(
    assignment_id: int,
    measurement_item_id: int,
    payload: MeasurementEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeasurementEntryRead:
    return MeasurementService(db).create_mobile_entry(
        assignment_id=assignment_id,
        measurement_item_id=measurement_item_id,
        current_user=current_user,
        payload=payload,
    )
