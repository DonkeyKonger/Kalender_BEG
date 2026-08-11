from datetime import date

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page
from app.core.database import get_db
from app.schemas.dashboard_note import (
    DashboardNoteCreate,
    DashboardNoteRead,
    DashboardNoteUpdate,
    DashboardNoteUserRead,
)
from app.schemas.measurement import (
    DashboardMessageCountRead,
    DashboardMessagesSummaryRead,
    MeasurementDashboardSubmissionRead,
)
from app.schemas.person import PersonRead
from app.schemas.site import SiteSummary
from app.schemas.weather import WeatherSummary
from app.services.dashboard_note_service import DashboardNoteService
from app.services.dashboard_message_service import DashboardMessageService
from app.services.dashboard_service import DashboardService
from app.services.measurement_service import MeasurementService
from app.services.weather_service import WeatherService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
CAN_READ_DASHBOARD = require_business_page("overview")
CAN_READ_MESSAGES = require_business_page("overview", "miscellaneous")
CAN_READ_DASHBOARD_NOTES = require_business_page(
    "overview",
    "calendar",
)


@router.get("/weather", response_model=WeatherSummary)
def get_company_weather(_user=Depends(CAN_READ_DASHBOARD)) -> WeatherSummary:
    return WeatherService().get_company_weather()

@router.get("/measurement-submissions", response_model=list[MeasurementDashboardSubmissionRead])
def get_measurement_submissions(
    limit: int = Query(default=6, ge=1, le=20),
    user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> list[MeasurementDashboardSubmissionRead]:
    return MeasurementService(db).list_dashboard_submissions(limit=limit, current_user=user)


@router.get("/overview")
def get_dashboard_overview(
    history_start: date,
    today: date,
    tomorrow: date,
    week_end: date,
    next_week_start: date,
    next_week_end: date,
    _user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> dict:
    return DashboardService(db).get_overview(
        history_start=history_start,
        today=today,
        tomorrow=tomorrow,
        week_end=week_end,
        next_week_start=next_week_start,
        next_week_end=next_week_end,
    )


@router.get("/notes", response_model=list[DashboardNoteRead])
def list_dashboard_notes(
    completed: bool | None = Query(default=None),
    site_id: int | None = Query(default=None, gt=0),
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> list[DashboardNoteRead]:
    notes = DashboardNoteService(db).list_notes(
        user_id=user.id,
        completed=completed,
        site_id=site_id,
    )
    return [DashboardNoteRead.model_validate(note) for note in notes]


@router.post("/notes", response_model=DashboardNoteRead, status_code=status.HTTP_201_CREATED)
def create_dashboard_note(
    payload: DashboardNoteCreate,
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> DashboardNoteRead:
    note = DashboardNoteService(db).create_note(payload, user_id=user.id)
    return DashboardNoteRead.model_validate(note)


@router.get("/notes/site-options", response_model=list[SiteSummary])
def list_dashboard_note_site_options(
    _user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> list[SiteSummary]:
    sites = DashboardNoteService(db).list_site_options()
    return [SiteSummary.model_validate(site) for site in sites]


@router.get("/notes/employee-options", response_model=list[PersonRead])
def list_dashboard_note_employee_options(
    _user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> list[PersonRead]:
    people = DashboardNoteService(db).list_employee_options()
    return [PersonRead.model_validate(person) for person in people]


@router.get("/notes/share-user-options", response_model=list[DashboardNoteUserRead])
def list_dashboard_note_share_user_options(
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> list[DashboardNoteUserRead]:
    users = DashboardNoteService(db).list_share_user_options(current_user_id=user.id)
    return [DashboardNoteUserRead.model_validate(option) for option in users]


@router.get("/notes/{note_id}", response_model=DashboardNoteRead)
def get_dashboard_note(
    note_id: int,
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> DashboardNoteRead:
    note = DashboardNoteService(db).get_note(note_id, user_id=user.id)
    return DashboardNoteRead.model_validate(note)


@router.patch("/notes/{note_id}", response_model=DashboardNoteRead)
def update_dashboard_note(
    note_id: int,
    payload: DashboardNoteUpdate,
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> DashboardNoteRead:
    note = DashboardNoteService(db).update_note(note_id, payload, user_id=user.id)
    return DashboardNoteRead.model_validate(note)


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard_note(
    note_id: int,
    user=Depends(CAN_READ_DASHBOARD_NOTES),
    db: Session = Depends(get_db),
) -> Response:
    DashboardNoteService(db).delete_note(note_id, user_id=user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/messages/summary", response_model=DashboardMessagesSummaryRead)
def get_dashboard_messages_summary(
    limit: int = Query(default=6, ge=1, le=20),
    user=Depends(CAN_READ_MESSAGES),
    db: Session = Depends(get_db),
) -> DashboardMessagesSummaryRead:
    return DashboardMessageService(db).get_summary(limit=limit, current_user=user)


@router.get("/messages/unread-count", response_model=DashboardMessageCountRead)
def get_dashboard_message_unread_count(
    user=Depends(CAN_READ_MESSAGES),
    db: Session = Depends(get_db),
) -> DashboardMessageCountRead:
    return DashboardMessageCountRead(
        count=DashboardMessageService(db).count_open_messages(current_user=user),
    )


@router.post("/messages/{message_key}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_dashboard_message(
    message_key: str,
    user=Depends(CAN_READ_MESSAGES),
    db: Session = Depends(get_db),
) -> Response:
    DashboardMessageService(db).dismiss_message(message_key=message_key, current_user=user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
