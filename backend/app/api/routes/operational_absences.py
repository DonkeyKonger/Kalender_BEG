from datetime import date

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_app_user, require_business_page
from app.core.database import get_db
from app.models.user import User
from app.schemas.operational_absence import (
    OperationalAbsenceCreate,
    OperationalAbsenceProjectManagerRead,
    OperationalAbsenceRead,
    OperationalAbsenceSiteRead,
)
from app.services.operational_absence_service import OperationalAbsenceService


router = APIRouter(prefix="/operational-absences", tags=["operational-absences"])
CAN_READ_MATRIX = require_business_page("calendar")


@router.get(
    "/project-manager-options",
    response_model=list[OperationalAbsenceProjectManagerRead],
)
def list_operational_absence_project_manager_options(
    _user: User = Depends(get_current_app_user),
    db: Session = Depends(get_db),
) -> list[OperationalAbsenceProjectManagerRead]:
    return [
        OperationalAbsenceProjectManagerRead.model_validate(person)
        for person in OperationalAbsenceService(db).list_project_manager_options()
    ]


@router.get("/site-options", response_model=list[OperationalAbsenceSiteRead])
def list_operational_absence_site_options(
    _user: User = Depends(get_current_app_user),
    db: Session = Depends(get_db),
) -> list[OperationalAbsenceSiteRead]:
    return [
        OperationalAbsenceSiteRead.model_validate(site)
        for site in OperationalAbsenceService(db).list_site_options()
    ]


@router.get("", response_model=list[OperationalAbsenceRead])
def list_operational_absences(
    start: date,
    end: date,
    _user: User = Depends(CAN_READ_MATRIX),
    db: Session = Depends(get_db),
) -> list[OperationalAbsenceRead]:
    return [
        OperationalAbsenceRead.model_validate(entry)
        for entry in OperationalAbsenceService(db).list_operational_absences(
            start=start,
            end=end,
        )
    ]


@router.post("", response_model=OperationalAbsenceRead, status_code=status.HTTP_201_CREATED)
def create_operational_absence(
    payload: OperationalAbsenceCreate,
    current_user: User = Depends(get_current_app_user),
    db: Session = Depends(get_db),
) -> OperationalAbsenceRead:
    entry = OperationalAbsenceService(db).create_operational_absence(
        payload,
        user_id=current_user.id,
    )
    return OperationalAbsenceRead.model_validate(entry)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_operational_absence(
    entry_id: int,
    current_user: User = Depends(get_current_app_user),
    db: Session = Depends(get_db),
) -> Response:
    OperationalAbsenceService(db).delete_operational_absence(
        entry_id,
        user_id=current_user.id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
