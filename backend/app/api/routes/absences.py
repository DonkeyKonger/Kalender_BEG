from datetime import date

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page
from app.core.database import get_db
from app.models.user import User
from app.schemas.absence import AbsenceCreate, AbsenceRead, AbsenceUpdate, VacationCarryoverRead, VacationCarryoverUpdate
from app.services.absence_service import AbsenceService

router = APIRouter(prefix="/absences", tags=["absences"])

CAN_READ = require_business_page(
    "absences",
    "employees",
    "calendar",
    "payroll",
)
CAN_WRITE = require_business_page("absences", "employees", "calendar")
CAN_CARRYOVER_WRITE = require_business_page(
    "employees",
)


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


@router.get("/vacation-carryover", response_model=VacationCarryoverRead)
def get_vacation_carryover(
    person_id: int,
    year: int,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> VacationCarryoverRead:
    carryover = AbsenceService(db).get_vacation_carryover(person_id=person_id, year=year)
    return VacationCarryoverRead(
        person_id=person_id,
        year=year,
        carryover_days=carryover.carryover_days if carryover is not None else 0,
    )


@router.put("/vacation-carryover", response_model=VacationCarryoverRead)
def update_vacation_carryover(
    payload: VacationCarryoverUpdate,
    current_user: User = Depends(CAN_CARRYOVER_WRITE),
    db: Session = Depends(get_db),
) -> VacationCarryoverRead:
    carryover = AbsenceService(db).set_vacation_carryover(
        person_id=payload.person_id,
        year=payload.year,
        carryover_days=payload.carryover_days,
        user_id=current_user.id,
    )
    return VacationCarryoverRead(
        person_id=carryover.person_id,
        year=carryover.year,
        carryover_days=carryover.carryover_days,
    )


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
