from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import TimeEntryCorrection, TimeEntryCreate, TimeEntryRead, TimeEntryUpdate
from app.services.gps_service import GpsPresenceEvaluation, GpsPresenceService
from app.services.time_entry_service import TimeEntryService

router = APIRouter(prefix="/time-entries", tags=["time-entries"])

CAN_ACCESS = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)
CAN_REVIEW = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)


@router.get("", response_model=list[TimeEntryRead])
def list_time_entries(
    person_id: int | None = None,
    site_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    include_gps_status: bool = False,
    review_open_only: bool = False,
    current_user: User = Depends(CAN_ACCESS),
    db: Session = Depends(get_db),
) -> list[TimeEntryRead]:
    service = TimeEntryService(db)
    entries = service.list_entries(
        current_user=current_user,
        person_id=person_id,
        site_id=site_id,
        date_from=date_from,
        date_to=date_to,
    )
    gps_service = GpsPresenceService(db) if include_gps_status or review_open_only else None
    gps_evaluations: dict[int, GpsPresenceEvaluation] = {}
    if gps_service is not None:
        gps_evaluations = {entry.id: gps_service.evaluate_time_entry(entry) for entry in entries}
    if review_open_only:
        service.auto_close_deadline_reviews(
            entries,
            {entry_id: evaluation.work_minutes for entry_id, evaluation in gps_evaluations.items()},
        )
        open_entries = []
        for entry in entries:
            gps_evaluation = gps_evaluations.get(entry.id)
            gps_work_minutes = gps_evaluation.work_minutes if gps_evaluation is not None else None
            if service.is_open_time_review_case(entry, gps_work_minutes):
                open_entries.append(entry)
        entries = open_entries
    return [time_entry_read(entry, gps_evaluation=gps_evaluations.get(entry.id)) for entry in entries]


@router.post("", response_model=TimeEntryRead, status_code=201)
def create_time_entry(
    payload: TimeEntryCreate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).create_entry(payload, current_user)
    return time_entry_read(entry)


@router.patch("/{entry_id}", response_model=TimeEntryRead)
def update_time_entry(
    entry_id: int,
    payload: TimeEntryUpdate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).update_entry(entry_id, payload, current_user)
    return time_entry_read(entry)


@router.post("/{entry_id}/review/approve", response_model=TimeEntryRead)
def approve_time_entry_review(
    entry_id: int,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).approve_time_review(entry_id, current_user)
    return time_entry_read(entry)


@router.post("/{entry_id}/review/correct", response_model=TimeEntryRead)
def correct_time_entry_review(
    entry_id: int,
    payload: TimeEntryCorrection,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).correct_time_review(entry_id, payload.corrected_work_minutes, current_user)
    return time_entry_read(entry)


def time_entry_read(
    entry: WorkTimeEntry,
    gps_service: GpsPresenceService | None = None,
    gps_evaluation: GpsPresenceEvaluation | None = None,
) -> TimeEntryRead:
    gps_status = None
    gps_matched_points = None
    gps_total_points = None
    gps_first_seen_at = None
    gps_last_seen_at = None
    gps_work_minutes = None
    if gps_evaluation is None and gps_service is not None:
        gps_evaluation = gps_service.evaluate_time_entry(entry)
    if gps_evaluation is not None:
        gps_status = gps_evaluation.status
        gps_matched_points = gps_evaluation.matched_points
        gps_total_points = gps_evaluation.total_points
        gps_first_seen_at = gps_evaluation.first_seen_at
        gps_last_seen_at = gps_evaluation.last_seen_at
        gps_work_minutes = gps_evaluation.work_minutes

    return TimeEntryRead(
        id=entry.id,
        person_id=entry.person_id,
        person_name=entry.person.display_name if entry.person else f"Person {entry.person_id}",
        site_id=entry.site_id,
        site_name=entry.site.name if entry.site else None,
        site_number=entry.site.site_number if entry.site else None,
        assignment_id=entry.assignment_id,
        work_date=entry.work_date,
        start_time=entry.start_time,
        end_time=entry.end_time,
        break_minutes=entry.break_minutes,
        travel_minutes=entry.travel_minutes,
        work_minutes=entry.work_minutes,
        original_work_minutes=entry.original_work_minutes,
        corrected_work_minutes=entry.corrected_work_minutes,
        note=entry.note,
        source=entry.source,
        status=entry.status,
        time_review_status=entry.time_review_status,
        time_review_method=entry.time_review_method,
        gps_status=gps_status,
        gps_matched_points=gps_matched_points,
        gps_total_points=gps_total_points,
        gps_first_seen_at=gps_first_seen_at,
        gps_last_seen_at=gps_last_seen_at,
        gps_work_minutes=gps_work_minutes,
        created_by_user_id=entry.created_by_user_id,
        reviewed_by_user_id=entry.reviewed_by_user_id,
        reviewed_at=entry.reviewed_at,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )
