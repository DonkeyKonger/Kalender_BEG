from datetime import date

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.schemas.measurement import (
    MeasurementEntryCreate,
    MeasurementEntryRead,
    MobileMeasurementBatchRead,
    MobileMeasurementItemRead,
)
from app.schemas.mobile import MobileAssignmentsResponse, MobileSite
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


@router.get("/sites", response_model=list[MobileSite])
def list_my_mobile_sites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileSite]:
    return MobileAssignmentService(db).list_active_sites_for_mobile(current_user=current_user)


@router.get(
    "/assignments/{assignment_id}/measurement-batches",
    response_model=list[MobileMeasurementBatchRead],
)
def list_my_assignment_measurement_batches(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementBatchRead]:
    return MeasurementService(db).list_mobile_batches(
        assignment_id=assignment_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches",
    response_model=MobileMeasurementBatchRead,
)
def create_my_assignment_measurement_batch(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).create_mobile_batch(
        assignment_id=assignment_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/submit",
    response_model=MobileMeasurementBatchRead,
)
def submit_my_assignment_measurement_batch(
    assignment_id: int,
    batch_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).submit_mobile_batch(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
    )


@router.get(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/items",
    response_model=list[MobileMeasurementItemRead],
)
def list_my_assignment_measurement_batch_items(
    assignment_id: int,
    batch_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementItemRead]:
    return MeasurementService(db).list_mobile_batch_items(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/items/{measurement_item_id}/entries",
    response_model=MeasurementEntryRead,
)
def create_my_assignment_measurement_entry(
    assignment_id: int,
    batch_id: int,
    measurement_item_id: int,
    payload: MeasurementEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeasurementEntryRead:
    return MeasurementService(db).create_mobile_entry(
        assignment_id=assignment_id,
        batch_id=batch_id,
        measurement_item_id=measurement_item_id,
        current_user=current_user,
        payload=payload,
    )


@router.delete(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/entries/{entry_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_my_assignment_measurement_entry(
    assignment_id: int,
    batch_id: int,
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    MeasurementService(db).delete_mobile_entry(
        assignment_id=assignment_id,
        batch_id=batch_id,
        entry_id=entry_id,
        current_user=current_user,
    )
