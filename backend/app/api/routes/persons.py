from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.person import PersonCreate, PersonRead, PersonUpdate
from app.services.person_service import PersonService

router = APIRouter(prefix="/persons", tags=["persons"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


@router.get("", response_model=list[PersonRead])
def list_persons(
    is_active: bool | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[PersonRead]:
    people = PersonService(db).list_people(is_active=is_active)
    return [PersonRead.model_validate(person) for person in people]


@router.post("", response_model=PersonRead, status_code=201)
def create_person(
    payload: PersonCreate,
    _user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).create_person(payload)
    return PersonRead.model_validate(person)


@router.patch("/{person_id}", response_model=PersonRead)
def update_person(
    person_id: int,
    payload: PersonUpdate,
    _user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).update_person(person_id, payload)
    return PersonRead.model_validate(person)
