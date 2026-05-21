from fastapi import APIRouter, Depends

from app.api.dependencies import require_roles
from app.models.enums import UserRole
from app.schemas.weather import WeatherSummary
from app.services.weather_service import WeatherService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
CAN_READ_DASHBOARD = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)


@router.get("/weather", response_model=WeatherSummary)
def get_company_weather(_user=Depends(CAN_READ_DASHBOARD)) -> WeatherSummary:
    return WeatherService().get_company_weather()
