from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.measurement import MeasurementDashboardSubmissionRead
from app.schemas.weather import WeatherSummary
from app.services.measurement_service import MeasurementService
from app.services.weather_service import WeatherService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
CAN_READ_DASHBOARD = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)


@router.get("/weather", response_model=WeatherSummary)
def get_company_weather(_user=Depends(CAN_READ_DASHBOARD)) -> WeatherSummary:
    return WeatherService().get_company_weather()

@router.get("/measurement-submissions", response_model=list[MeasurementDashboardSubmissionRead])
def get_measurement_submissions(
    limit: int = Query(default=6, ge=1, le=20),
    _user=Depends(CAN_READ_DASHBOARD),
    db: Session = Depends(get_db),
) -> list[MeasurementDashboardSubmissionRead]:
    return MeasurementService(db).list_dashboard_submissions(limit=limit)
