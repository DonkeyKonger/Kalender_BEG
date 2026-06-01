from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.gps_point import GpsPoint
from app.models.user import User
from app.schemas.gps import GpsLocationPointCreate, GpsLocationPointRead
from app.services.gps_service import GpsPresenceService


router = APIRouter(prefix="/gps", tags=["gps"])

CAN_SEND_GPS = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)


@router.post("/location-points", response_model=GpsLocationPointRead, status_code=status.HTTP_201_CREATED)
def create_location_point(
    payload: GpsLocationPointCreate,
    current_user: User = Depends(CAN_SEND_GPS),
    db: Session = Depends(get_db),
) -> GpsLocationPointRead:
    point = GpsPresenceService(db).create_location_point(payload, current_user)
    return gps_location_point_read(point)


def gps_location_point_read(point: GpsPoint) -> GpsLocationPointRead:
    return GpsLocationPointRead(
        id=point.id,
        person_id=point.person_id or 0,
        captured_at=point.timestamp,
        latitude=point.latitude,
        longitude=point.longitude,
        accuracy_meters=point.accuracy_m,
    )
