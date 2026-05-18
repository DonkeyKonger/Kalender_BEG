from datetime import date

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.absence import AbsenceCreate, AbsenceRead, AbsenceUpdate
from app.services.absence_service import AbsenceService

router = APIRouter(prefix="/absences", tags=["absences"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


@router.get("", response_model=list[AbsenceRead])
def list_absences(
    start: date | None = None,
    end: date | None = None,
    person_id: int | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[AbsenceRead]:
    absences = AbsenceService(db).list_absences(
        start=start,
        end=end,
        person_id=person_id,
    )
    return [AbsenceRead.model_validate(item) for item in absences]


@router.post("", response_model=AbsenceRead, status_code=201)
def create_absence(
    payload: AbsenceCreate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AbsenceRead:
    absence = AbsenceService(db).create_absence(payload, current_user.id)
    return AbsenceRead.model_validate(absence)


@router.patch("/{absence_id}", response_model=AbsenceRead)
def update_absence(
    absence_id: int,
    payload: AbsenceUpdate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AbsenceRead:
    absence = AbsenceService(db).update_absence(absence_id, payload, current_user.id)
    return AbsenceRead.model_validate(absence)


@router.delete("/{absence_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_absence(
    absence_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> Response:
    AbsenceService(db).delete_absence(absence_id, current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
