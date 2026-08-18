from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page, require_office_page
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import (
    TimeEntryCorrection,
    TimeEntryCreate,
    TimeEntryPayrollCorrectionUpdate,
    TimeEntryPayrollDateCorrectionUpdate,
    TimeEntryPayrollDeleteRead,
    TimeEntryPayrollWeekDayRead,
    TimeEntryPayrollWeekPersonRead,
    TimeEntryPayrollWeekRead,
    PersonWorkDayRead,
    PersonWorkDayOvernightUpdate,
    TimeEntryPayrollReviewUpdate,
    TimeEntryRead,
    TimeEntryReviewDecision,
    TimeEntryUpdate,
    TimeEntryWeeklyReviewCreate,
    TimeEntryWeeklyReviewRead,
)
from app.services.gps_service import GpsPresenceEvaluation, GpsPresenceService, GpsSiteStay
from app.services.person_hours_account_service import PersonHoursAccountService
from app.services.time_entry_service import TimeEntryService

router = APIRouter(prefix="/time-entries", tags=["time-entries"])

CAN_ACCESS = require_office_page(
    "payroll",
    "sites",
    roles=(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR),
)
CAN_WRITE = require_office_page(
    "payroll",
    roles=(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR),
)
CAN_REVIEW = require_business_page("payroll")


@router.get("/payroll-week", response_model=TimeEntryPayrollWeekRead)
def get_time_entry_payroll_week(
    iso_year: int = Query(ge=2000, le=2100),
    iso_week: int = Query(ge=1, le=53),
    _current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryPayrollWeekRead:
    try:
        week_start = date.fromisocalendar(iso_year, iso_week, 1)
        week_end = date.fromisocalendar(iso_year, iso_week, 7)
    except ValueError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Kalenderwoche.") from error
    summaries = PersonHoursAccountService(db).payroll_week_summaries(
        iso_year=iso_year,
        iso_week=iso_week,
    )
    return TimeEntryPayrollWeekRead(
        iso_year=iso_year,
        iso_week=iso_week,
        start_date=week_start,
        end_date=week_end,
        persons=[
            TimeEntryPayrollWeekPersonRead(
                person_id=summary.person_id,
                work_minutes=summary.work_minutes,
                vacation_credit_minutes=summary.vacation_credit_minutes,
                total_minutes=summary.total_minutes,
                vacation_days=[
                    TimeEntryPayrollWeekDayRead(
                        work_date=day.work_date,
                        vacation_credit_minutes=day.credit_minutes,
                    )
                    for day in summary.vacation_days
                ],
            )
            for summary in summaries
        ],
    )


@router.get("", response_model=list[TimeEntryRead])
def list_time_entries(
    person_id: int | None = None,
    site_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    include_gps_status: bool = False,
    review_open_only: bool = False,
    project_mounting_only: bool = False,
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
    gps_service = GpsPresenceService(db) if include_gps_status or review_open_only or project_mounting_only else None
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
            has_gps_review_notice = bool(gps_evaluation is not None and gps_evaluation.review_notices)
            if service.is_open_time_review_case(entry, gps_work_minutes) or (
                gps_evaluation is not None and (gps_evaluation.has_source_mismatch or has_gps_review_notice)
            ):
                open_entries.append(entry)
        entries = open_entries
    if project_mounting_only:
        entries = [
            entry
            for entry in entries
            if service.is_project_mounting_time_relevant(entry, gps_evaluations.get(entry.id))
        ]
    project_mounting_contexts = (
        service.project_mounting_contexts(entries)
        if project_mounting_only
        else {}
    )
    response_entries = [
        time_entry_read(
            entry,
            gps_evaluation=gps_evaluations.get(entry.id),
            project_mounting_context=project_mounting_contexts.get(entry.id),
        )
        for entry in entries
    ]
    if (
        review_open_only
        and not project_mounting_only
        and gps_service is not None
        and date_from is not None
        and date_to is not None
    ):
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


@router.get("/day-status", response_model=PersonWorkDayRead)
def get_time_entry_day_status(
    person_id: int,
    work_date: date,
    current_user: User = Depends(CAN_ACCESS),
    db: Session = Depends(get_db),
) -> PersonWorkDayRead:
    overnight_status = TimeEntryService(db).get_overnight_status(
        current_user=current_user,
        person_id=person_id,
        work_date=work_date,
    )
    return PersonWorkDayRead(
        person_id=person_id,
        work_date=work_date,
        overnight_status=overnight_status,
    )


@router.patch("/day-status", response_model=PersonWorkDayRead)
def update_time_entry_day_overnight_status(
    payload: PersonWorkDayOvernightUpdate,
    person_id: int,
    work_date: date,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> PersonWorkDayRead:
    overnight_status = TimeEntryService(db).set_payroll_overnight_status(
        current_user=current_user,
        person_id=person_id,
        work_date=work_date,
        overnight_status=payload.overnight_status,
    )
    return PersonWorkDayRead(
        person_id=person_id,
        work_date=work_date,
        overnight_status=overnight_status,
    )


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


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_time_entry(
    entry_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> None:
    TimeEntryService(db).delete_entry(entry_id, current_user)


@router.delete("/{entry_id}/payroll", response_model=TimeEntryPayrollDeleteRead)
def delete_time_entry_from_payroll_review(
    entry_id: int,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryPayrollDeleteRead:
    result = TimeEntryService(db).delete_payroll_entry(entry_id, current_user)
    return TimeEntryPayrollDeleteRead(
        entry_id=result.entry_id,
        person_id=result.person_id,
        iso_year=result.iso_year,
        iso_week=result.iso_week,
        weekly_review_reset=result.weekly_review_reset,
    )


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


@router.post("/{entry_id}/payroll-review", response_model=TimeEntryRead)
def set_time_entry_payroll_review(
    entry_id: int,
    payload: TimeEntryPayrollReviewUpdate,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).set_payroll_row_review(
        entry_id,
        reviewed=payload.reviewed,
        current_user=current_user,
    )
    return time_entry_read(entry)


@router.post("/{entry_id}/payroll-correction", response_model=TimeEntryRead)
def set_time_entry_payroll_correction(
    entry_id: int,
    payload: TimeEntryPayrollCorrectionUpdate,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).set_payroll_time_correction(
        entry_id,
        start_time=payload.payroll_corrected_start_time,
        end_time=payload.payroll_corrected_end_time,
        break_minutes=payload.payroll_corrected_break_minutes,
        work_minutes=payload.payroll_corrected_work_minutes,
        current_user=current_user,
    )
    return time_entry_read(entry)


@router.post("/{entry_id}/payroll-date-correction", response_model=TimeEntryRead)
def set_time_entry_payroll_date_correction(
    entry_id: int,
    payload: TimeEntryPayrollDateCorrectionUpdate,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryRead:
    entry = TimeEntryService(db).set_payroll_date_correction(
        entry_id,
        work_date=payload.work_date,
        current_user=current_user,
    )
    return time_entry_read(entry)


@router.get("/weekly-reviews", response_model=list[TimeEntryWeeklyReviewRead])
def list_time_entry_weekly_reviews(
    iso_year: int,
    iso_week: int | None = None,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> list[TimeEntryWeeklyReviewRead]:
    return TimeEntryService(db).list_weekly_reviews(
        iso_year=iso_year,
        iso_week=iso_week,
        current_user=current_user,
    )


@router.post("/weekly-reviews", response_model=TimeEntryWeeklyReviewRead, status_code=201)
def mark_time_entry_weekly_review(
    payload: TimeEntryWeeklyReviewCreate,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryWeeklyReviewRead:
    return TimeEntryService(db).mark_weekly_review(
        person_id=payload.person_id,
        iso_year=payload.iso_year,
        iso_week=payload.iso_week,
        current_user=current_user,
    )


@router.post("/weekly-reviews/reset", response_model=TimeEntryWeeklyReviewRead)
def reset_time_entry_weekly_review(
    payload: TimeEntryWeeklyReviewCreate,
    current_user: User = Depends(CAN_REVIEW),
    db: Session = Depends(get_db),
) -> TimeEntryWeeklyReviewRead:
    return TimeEntryService(db).reset_weekly_review(
        person_id=payload.person_id,
        iso_year=payload.iso_year,
        iso_week=payload.iso_week,
        current_user=current_user,
    )


def time_entry_read(
    entry: WorkTimeEntry,
    gps_service: GpsPresenceService | None = None,
    gps_evaluation: GpsPresenceEvaluation | None = None,
    project_mounting_context: dict[str, object] | None = None,
) -> TimeEntryRead:
    gps_status = None
    gps_matched_points = None
    gps_total_points = None
    gps_first_seen_at = None
    gps_last_seen_at = None
    gps_work_minutes = None
    planned_site_labels = []
    gps_detected_site_id = None
    gps_detected_site_name = None
    gps_detected_site_number = None
    gps_detected_location_type = None
    planned_vs_gps_mismatch = False
    manual_vs_planned_mismatch = False
    manual_vs_gps_mismatch = False
    gps_not_checkable = False
    mismatch_notice = None
    review_notices = []
    if gps_evaluation is None and gps_service is not None:
        gps_evaluation = gps_service.evaluate_time_entry(entry)
    if gps_evaluation is not None:
        gps_status = gps_evaluation.status
        gps_matched_points = gps_evaluation.matched_points
        gps_total_points = gps_evaluation.total_points
        gps_first_seen_at = gps_evaluation.first_seen_at
        gps_last_seen_at = gps_evaluation.last_seen_at
        gps_work_minutes = gps_evaluation.work_minutes
        planned_site_labels = list(gps_evaluation.planned_site_labels)
        gps_detected_site_id = gps_evaluation.gps_detected_site_id
        gps_detected_site_name = gps_evaluation.gps_detected_site_name
        gps_detected_site_number = gps_evaluation.gps_detected_site_number
        gps_detected_location_type = gps_evaluation.gps_detected_location_type
        planned_vs_gps_mismatch = gps_evaluation.planned_vs_gps_mismatch
        manual_vs_planned_mismatch = gps_evaluation.manual_vs_planned_mismatch
        manual_vs_gps_mismatch = gps_evaluation.manual_vs_gps_mismatch
        gps_not_checkable = gps_evaluation.gps_not_checkable
        mismatch_notice = gps_evaluation.mismatch_notice
        review_notices = list(gps_evaluation.review_notices)

    project_mounting_multiplier = int(project_mounting_context.get("multiplier", 1)) if project_mounting_context else 1
    project_mounting_external_person_count = (
        int(project_mounting_context.get("external_person_count", 0))
        if project_mounting_context
        else 0
    )
    project_mounting_participant_ids = (
        list(project_mounting_context.get("participant_ids", []))
        if project_mounting_context
        else []
    )
    project_mounting_participant_names = (
        list(project_mounting_context.get("participant_names", []))
        if project_mounting_context
        else []
    )
    project_mounting_base_work_minutes = (
        int(project_mounting_context["base_work_minutes"])
        if project_mounting_context and project_mounting_context.get("base_work_minutes") is not None
        else None
    )
    project_mounting_work_minutes = (
        int(project_mounting_context["work_minutes"])
        if project_mounting_context and project_mounting_context.get("work_minutes") is not None
        else None
    )
    project_mounting_break_minutes = (
        int(project_mounting_context["break_minutes"])
        if project_mounting_context and project_mounting_context.get("break_minutes") is not None
        else None
    )
    project_mounting_travel_minutes = (
        int(project_mounting_context["travel_minutes"])
        if project_mounting_context and project_mounting_context.get("travel_minutes") is not None
        else None
    )

    return TimeEntryRead(
        id=entry.id,
        person_id=entry.person_id,
        person_name=entry.person.display_name if entry.person else f"Person {entry.person_id}",
        person_type=entry.person.person_type.value if entry.person else None,
        site_id=entry.site_id,
        site_name=entry.site.name if entry.site else None,
        site_number=entry.site.site_number if entry.site else None,
        original_site_id=entry.original_site_id,
        original_site_name=entry.original_site.name if entry.original_site else None,
        original_site_number=entry.original_site.site_number if entry.original_site else None,
        assignment_id=entry.assignment_id,
        work_date=entry.work_date,
        overnight_status=entry.work_day.overnight_status if entry.work_day else None,
        original_work_date=entry.original_work_date,
        start_time=entry.start_time,
        end_time=entry.end_time,
        break_minutes=project_mounting_break_minutes if project_mounting_break_minutes is not None else entry.break_minutes,
        travel_minutes=project_mounting_travel_minutes if project_mounting_travel_minutes is not None else entry.travel_minutes,
        work_minutes=project_mounting_work_minutes if project_mounting_work_minutes is not None else entry.work_minutes,
        original_work_minutes=entry.original_work_minutes,
        corrected_work_minutes=entry.corrected_work_minutes,
        payroll_corrected_start_time=entry.payroll_corrected_start_time,
        payroll_corrected_end_time=entry.payroll_corrected_end_time,
        payroll_corrected_break_minutes=entry.payroll_corrected_break_minutes,
        payroll_corrected_work_minutes=entry.payroll_corrected_work_minutes,
        project_mounting_multiplier=project_mounting_multiplier,
        project_mounting_external_person_count=project_mounting_external_person_count,
        project_mounting_participant_ids=project_mounting_participant_ids,
        project_mounting_participant_names=project_mounting_participant_names,
        project_mounting_base_work_minutes=project_mounting_base_work_minutes,
        project_mounting_work_minutes=project_mounting_work_minutes,
        project_mounting_break_minutes=project_mounting_break_minutes,
        project_mounting_travel_minutes=project_mounting_travel_minutes,
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
        payroll_reviewed_by_user_id=entry.payroll_reviewed_by_user_id,
        payroll_reviewed_at=entry.payroll_reviewed_at,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
        planned_site_labels=planned_site_labels,
        gps_detected_site_id=gps_detected_site_id,
        gps_detected_site_name=gps_detected_site_name,
        gps_detected_site_number=gps_detected_site_number,
        gps_detected_location_type=gps_detected_location_type,
        planned_vs_gps_mismatch=planned_vs_gps_mismatch,
        manual_vs_planned_mismatch=manual_vs_planned_mismatch,
        manual_vs_gps_mismatch=manual_vs_gps_mismatch,
        gps_not_checkable=gps_not_checkable,
        mismatch_notice=mismatch_notice,
        review_notices=review_notices,
        payroll_review_state=TimeEntryService.payroll_review_state(
            entry,
            gps_work_minutes=gps_work_minutes,
            review_notices=review_notices,
        ),
    )


def gps_suggestion_read(stay: GpsSiteStay, *, synthetic_id: int) -> TimeEntryRead:
    return TimeEntryRead(
        id=synthetic_id,
        person_id=stay.person_id,
        person_name=stay.person_name,
        person_type=None,
        site_id=stay.site_id,
        site_name=stay.site_name,
        site_number=stay.site_number,
        original_site_id=stay.site_id,
        original_site_name=stay.site_name,
        original_site_number=stay.site_number,
        assignment_id=None,
        work_date=stay.work_date,
        overnight_status=None,
        original_work_date=None,
        start_time=None,
        end_time=None,
        break_minutes=0,
        travel_minutes=0,
        work_minutes=0,
        original_work_minutes=None,
        corrected_work_minutes=None,
        payroll_corrected_start_time=None,
        payroll_corrected_end_time=None,
        payroll_corrected_break_minutes=None,
        payroll_corrected_work_minutes=None,
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
        payroll_reviewed_by_user_id=None,
        payroll_reviewed_at=None,
        created_at=stay.last_seen_at,
        updated_at=stay.last_seen_at,
        review_source="gps_suggestion",
        is_gps_suggestion=True,
        has_manual_entry=False,
        gps_suggestion_key=f"{stay.person_id}:{stay.work_date.isoformat()}:{stay.site_id}",
        planned_site_labels=list(stay.planned_site_labels),
        gps_detected_site_id=stay.site_id,
        gps_detected_site_name=stay.site_name,
        gps_detected_site_number=stay.site_number,
        gps_detected_location_type="site",
        planned_vs_gps_mismatch=stay.planned_vs_gps_mismatch,
        manual_vs_planned_mismatch=False,
        manual_vs_gps_mismatch=False,
        gps_not_checkable=False,
        mismatch_notice=stay.mismatch_notice,
        review_notices=list(stay.review_notices),
        payroll_review_state={
            "state": "open",
            "is_auto_plausible": False,
        },
    )
