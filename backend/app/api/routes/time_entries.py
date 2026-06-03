from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import (
    TimeEntryCorrection,
    TimeEntryCreate,
    TimeEntryRead,
    TimeEntryReviewDecision,
    TimeEntryUpdate,
)
from app.services.gps_service import GpsPresenceEvaluation, GpsPresenceService, GpsSiteStay
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
    manual_site_keys = {
        (entry.person_id, entry.work_date, entry.site_id)
        for entry in entries
        if entry.site_id is not None
    }
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
    response_entries = [time_entry_read(entry, gps_evaluation=gps_evaluations.get(entry.id)) for entry in entries]
    if review_open_only and gps_service is not None and date_from is not None and date_to is not None:
        gps_person_id = current_user.person_id if current_user.role == UserRole.MONTEUR else person_id
        gps_suggestions = [
            stay
            for stay in gps_service.list_site_stays_for_review(
                date_from=date_from,
                date_to=date_to,
                person_id=gps_person_id,
                site_id=site_id,
            )
            if (stay.person_id, stay.work_date, stay.site_id) not in manual_site_keys
        ]
        response_entries.extend(
            gps_suggestion_read(stay, synthetic_id=-(index + 1))
            for index, stay in enumerate(gps_suggestions)
        )
    return response_entries


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


@router.post("/{entry_id}/review/decision", response_model=TimeEntryRead)
def decide_time_entry_review(
    entry_id: int,
    payload: TimeEntryReviewDecision,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).apply_time_review_decision(
        entry_id,
        decision=payload.decision,
        final_work_minutes=payload.final_work_minutes,
        reviewed_site_id=payload.reviewed_site_id,
        current_user=current_user,
    )
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


def gps_suggestion_read(stay: GpsSiteStay, *, synthetic_id: int) -> TimeEntryRead:
    return TimeEntryRead(
        id=synthetic_id,
        person_id=stay.person_id,
        person_name=stay.person_name,
        site_id=stay.site_id,
        site_name=stay.site_name,
        site_number=stay.site_number,
        assignment_id=None,
        work_date=stay.work_date,
        start_time=None,
        end_time=None,
        break_minutes=0,
        travel_minutes=0,
        work_minutes=0,
        original_work_minutes=None,
        corrected_work_minutes=None,
        note="GPS erkannt · kein manueller Eintrag",
        source="gps_suggestion",
        status="draft",
        time_review_status="open",
        time_review_method=None,
        gps_status="matched",
        gps_matched_points=stay.matched_points,
        gps_total_points=stay.matched_points,
        gps_first_seen_at=stay.first_seen_at,
        gps_last_seen_at=stay.last_seen_at,
        gps_work_minutes=stay.work_minutes,
        created_by_user_id=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
        created_at=stay.last_seen_at,
        updated_at=stay.last_seen_at,
        review_source="gps_suggestion",
        is_gps_suggestion=True,
        has_manual_entry=False,
        gps_suggestion_key=f"{stay.person_id}:{stay.work_date.isoformat()}:{stay.site_id}",
    )
