from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, File, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_app_user as get_current_user
from app.core.database import get_db
from app.models.user import User
from app.schemas.extra_work import (
    ExtraWorkTicketCreate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkTicketEntryRead,
    ExtraWorkTicketRead,
    ExtraWorkTicketStatusUpdate,
)
from app.schemas.measurement import (
    CustomerSignatureCreate,
    MeasurementEntryCreate,
    MeasurementEntryRead,
    MobileMeasurementBatchRead,
    MobileMeasurementBatchPhotoRead,
    MobileMeasurementItemRead,
    WorkerSignatureCreate,
)
from app.schemas.mobile import MobileAssignment, MobileAssignmentsResponse, MobileSelfPlanRequest, MobileSite
from app.services.measurement_pdf_service import MeasurementPdfService
from app.services.measurement_service import MeasurementService
from app.services.mobile_assignment_service import MobileAssignmentService
from app.services.extra_work_service import ExtraWorkService
from app.services.extra_work_pdf_service import ExtraWorkPdfService

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


@router.get("/sites/recently-planned", response_model=list[MobileSite])
def list_my_recently_planned_sites(
    months: int = Query(12, ge=1, le=24),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileSite]:
    return MobileAssignmentService(db).list_recently_planned_sites(
        current_user=current_user,
        months=months,
    )


@router.post(
    "/assignments/self-plan",
    response_model=MobileAssignment,
    status_code=status.HTTP_201_CREATED,
)
def self_plan_my_assignment(
    payload: MobileSelfPlanRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileAssignment:
    return MobileAssignmentService(db).self_plan_assignment(
        current_user=current_user,
        payload=payload,
    )


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
    "/assignments/{assignment_id}/extra-work-tickets",
    response_model=list[ExtraWorkTicketRead],
)
def list_my_assignment_extra_work_tickets(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ExtraWorkTicketRead]:
    return ExtraWorkService(db).list_mobile_tickets(
        assignment_id=assignment_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/extra-work-tickets",
    response_model=ExtraWorkTicketRead,
    status_code=status.HTTP_201_CREATED,
)
def create_my_assignment_extra_work_ticket(
    assignment_id: int,
    payload: ExtraWorkTicketCreate | None = Body(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketRead:
    return ExtraWorkService(db).create_mobile_ticket(
        assignment_id=assignment_id,
        current_user=current_user,
        payload=payload,
    )


@router.get(
    "/assignments/{assignment_id}/extra-work-tickets/{ticket_id}",
    response_model=ExtraWorkTicketRead,
)
def get_my_assignment_extra_work_ticket(
    assignment_id: int,
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketRead:
    return ExtraWorkService(db).get_mobile_ticket(
        assignment_id=assignment_id,
        ticket_id=ticket_id,
        current_user=current_user,
    )


@router.patch(
    "/assignments/{assignment_id}/extra-work-tickets/{ticket_id}/status",
    response_model=ExtraWorkTicketRead,
)
def update_my_assignment_extra_work_ticket_status(
    assignment_id: int,
    ticket_id: int,
    payload: ExtraWorkTicketStatusUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketRead:
    return ExtraWorkService(db).update_mobile_ticket_status(
        assignment_id=assignment_id,
        ticket_id=ticket_id,
        next_status=payload.status,
        current_user=current_user,
    )


@router.get(
    "/assignments/{assignment_id}/extra-work-tickets/{ticket_id}/entry",
    response_model=ExtraWorkTicketEntryRead | None,
)
def get_my_assignment_extra_work_ticket_entry(
    assignment_id: int,
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketEntryRead | None:
    return ExtraWorkService(db).get_mobile_ticket_entry(
        assignment_id=assignment_id,
        ticket_id=ticket_id,
        current_user=current_user,
    )


@router.put(
    "/assignments/{assignment_id}/extra-work-tickets/{ticket_id}/entry",
    response_model=ExtraWorkTicketEntryRead,
)
def upsert_my_assignment_extra_work_ticket_entry(
    assignment_id: int,
    ticket_id: int,
    payload: ExtraWorkTicketEntryPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketEntryRead:
    return ExtraWorkService(db).upsert_mobile_ticket_entry(
        assignment_id=assignment_id,
        ticket_id=ticket_id,
        current_user=current_user,
        payload=payload,
    )


@router.get("/assignments/{assignment_id}/extra-work-tickets/{ticket_id}/pdf")
def download_my_assignment_extra_work_ticket_pdf(
    assignment_id: int,
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    content, filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment_id,
        ticket_id=ticket_id,
        current_user=current_user,
    )
    quoted = quote(filename)
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quoted}"},
    )


@router.get("/assignments/{assignment_id}/measurement-batches/{batch_id}/pdf")
def download_my_assignment_measurement_batch_pdf(
    assignment_id: int,
    batch_id: int,
    mode: str = Query("original", pattern="^(checked|original)$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    assignment = MeasurementService(db)._get_user_assignment(assignment_id, current_user)
    content, filename = MeasurementPdfService(db).build_batch_pdf(
        site_id=assignment.site_id,
        batch_id=batch_id,
        mode=mode,
    )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.get("/assignments/{assignment_id}/measurement-timesheet/pdf")
def download_my_assignment_measurement_timesheet_pdf(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    assignment = MeasurementService(db)._get_user_assignment(assignment_id, current_user)
    content, filename = MeasurementPdfService(db).build_active_timesheet_pdf(
        site_id=assignment.site_id,
    )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/customer-signature",
    response_model=MobileMeasurementBatchRead,
)
def sign_my_assignment_measurement_batch(
    assignment_id: int,
    batch_id: int,
    payload: CustomerSignatureCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).sign_mobile_batch(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
        payload=payload,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/worker-signature",
    response_model=MobileMeasurementBatchRead,
)
def sign_my_assignment_measurement_batch_worker(
    assignment_id: int,
    batch_id: int,
    payload: WorkerSignatureCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).sign_mobile_batch_worker(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
        payload=payload,
    )


@router.get(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/photos",
    response_model=list[MobileMeasurementBatchPhotoRead],
)
def list_my_assignment_measurement_batch_photos(
    assignment_id: int,
    batch_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementBatchPhotoRead]:
    return MeasurementService(db).list_mobile_batch_photos(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
    )


@router.post(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/photos",
    response_model=MobileMeasurementBatchPhotoRead,
)
async def upload_my_assignment_measurement_batch_photo(
    assignment_id: int,
    batch_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchPhotoRead:
    return MeasurementService(db).upload_mobile_batch_photo(
        assignment_id=assignment_id,
        batch_id=batch_id,
        current_user=current_user,
        filename=file.filename,
        content=await file.read(),
        content_type=file.content_type,
    )


@router.get(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/photos/{photo_id}/content",
)
def download_my_assignment_measurement_batch_photo(
    assignment_id: int,
    batch_id: int,
    photo_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    content, content_type, filename = MeasurementService(db).get_mobile_batch_photo_content(
        assignment_id=assignment_id,
        batch_id=batch_id,
        photo_id=photo_id,
        current_user=current_user,
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.delete(
    "/assignments/{assignment_id}/measurement-batches/{batch_id}/photos/{photo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_my_assignment_measurement_batch_photo(
    assignment_id: int,
    batch_id: int,
    photo_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    MeasurementService(db).delete_mobile_batch_photo(
        assignment_id=assignment_id,
        batch_id=batch_id,
        photo_id=photo_id,
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
