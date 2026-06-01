from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import TimeEntryCreate, TimeEntryRead, TimeEntryUpdate
from app.services.gps_service import GpsPresenceService
from app.services.time_entry_service import TimeEntryService

router = APIRouter(prefix="/time-entries", tags=["time-entries"])

CAN_ACCESS = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)


@router.get("", response_model=list[TimeEntryRead])
def list_time_entries(
    person_id: int | None = None,
    site_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    include_gps_status: bool = False,
    current_user: User = Depends(CAN_ACCESS),
    db: Session = Depends(get_db),
) -> list[TimeEntryRead]:
    entries = TimeEntryService(db).list_entries(
        current_user=current_user,
        person_id=person_id,
        site_id=site_id,
        date_from=date_from,
        date_to=date_to,
    )
    gps_service = GpsPresenceService(db) if include_gps_status else None
    return [time_entry_read(entry, gps_service=gps_service) for entry in entries]


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


def time_entry_read(entry: WorkTimeEntry, gps_service: GpsPresenceService | None = None) -> TimeEntryRead:
    gps_status = None
    gps_matched_points = None
    gps_total_points = None
    if gps_service is not None:
        gps_evaluation = gps_service.evaluate_time_entry(entry)
        gps_status = gps_evaluation.status
        gps_matched_points = gps_evaluation.matched_points
        gps_total_points = gps_evaluation.total_points

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
        note=entry.note,
        source=entry.source,
        status=entry.status,
        gps_status=gps_status,
        gps_matched_points=gps_matched_points,
        gps_total_points=gps_total_points,
        created_by_user_id=entry.created_by_user_id,
        reviewed_by_user_id=entry.reviewed_by_user_id,
        reviewed_at=entry.reviewed_at,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )
