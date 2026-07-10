from datetime import date

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_office_page
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.dashboard_note import DashboardNoteCreate, DashboardNoteRead, DashboardNoteUpdate
from app.schemas.measurement import DashboardMessagesSummaryRead, MeasurementDashboardSubmissionRead
from app.schemas.weather import WeatherSummary
from app.services.dashboard_note_service import DashboardNoteService
from app.services.dashboard_service import DashboardService
from app.services.measurement_service import MeasurementService
from app.services.weather_service import WeatherService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
CAN_READ_DASHBOARD = require_office_page("overview", roles=(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE))


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
    _user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> list[DashboardNoteRead]:
    notes = DashboardNoteService(db).list_notes(completed=completed)
    return [DashboardNoteRead.model_validate(note) for note in notes]


@router.post("/notes", response_model=DashboardNoteRead, status_code=status.HTTP_201_CREATED)
def create_dashboard_note(
    payload: DashboardNoteCreate,
    user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> DashboardNoteRead:
    note = DashboardNoteService(db).create_note(payload, user_id=user.id)
    return DashboardNoteRead.model_validate(note)


@router.patch("/notes/{note_id}", response_model=DashboardNoteRead)
def update_dashboard_note(
    note_id: int,
    payload: DashboardNoteUpdate,
    _user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> DashboardNoteRead:
    note = DashboardNoteService(db).update_note(note_id, payload)
    return DashboardNoteRead.model_validate(note)


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard_note(
    note_id: int,
    user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> Response:
    DashboardNoteService(db).delete_note(note_id, user_id=user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/messages/summary", response_model=DashboardMessagesSummaryRead)
def get_dashboard_messages_summary(
    limit: int = Query(default=6, ge=1, le=20),
    user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> DashboardMessagesSummaryRead:
    return MeasurementService(db).get_dashboard_messages_summary(limit=limit, current_user=user)


@router.post("/messages/{message_key}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_dashboard_message(
    message_key: str,
    user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> Response:
    MeasurementService(db).dismiss_dashboard_message(message_key=message_key, current_user=user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
