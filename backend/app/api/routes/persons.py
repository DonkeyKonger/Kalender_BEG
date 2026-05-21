from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.person import (
    PersonCreate,
    PersonGeocodeSearchResult,
    PersonMapResponse,
    PersonRead,
    PersonRemovePlan,
    PersonRemoveResponse,
    PersonUpdate,
)
from app.services.geo_service import search_geocoding_candidates
from app.services.person_service import PersonService

router = APIRouter(prefix="/persons", tags=["persons"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
CAN_ADMIN = require_roles(UserRole.ADMIN)


@router.get("", response_model=list[PersonRead])
def list_persons(
    is_active: bool | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[PersonRead]:
    people = PersonService(db).list_people(is_active=is_active)
    return [PersonRead.model_validate(person) for person in people]


@router.get("/map", response_model=PersonMapResponse)
def person_map(
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> PersonMapResponse:
    return PersonService(db).person_map()


@router.get("/geocode/search", response_model=list[PersonGeocodeSearchResult])
def search_person_geocode(
    q: str = Query(..., min_length=3, max_length=200),
    limit: int = Query(default=5, ge=1, le=5),
    _user=Depends(CAN_READ),
) -> list[PersonGeocodeSearchResult]:
    return [
        PersonGeocodeSearchResult(
            label=candidate.label,
            postal_code=candidate.postal_code,
            city=candidate.city,
            street=candidate.street,
            house_number=candidate.house_number,
            latitude=candidate.latitude,
            longitude=candidate.longitude,
            confidence=candidate.confidence,
            source=candidate.source,
        )
        for candidate in search_geocoding_candidates(q, limit=limit)
    ]


@router.get("/{person_id}/removal-plan", response_model=PersonRemovePlan)
def person_removal_plan(
    person_id: int,
    _user=Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> PersonRemovePlan:
    return PersonRemovePlan(action=PersonService(db).remove_plan(person_id))


@router.post("/{person_id}/remove", response_model=PersonRemoveResponse)
def remove_person(
    person_id: int,
    current_user=Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> PersonRemoveResponse:
    action, person = PersonService(db).remove_person(person_id, current_user.id)
    return PersonRemoveResponse(action=action, person=PersonRead.model_validate(person) if person else None)


@router.post("", response_model=PersonRead, status_code=201)
def create_person(
    payload: PersonCreate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).create_person(payload, current_user.id)
    return PersonRead.model_validate(person)


@router.patch("/{person_id}", response_model=PersonRead)
def update_person(
    person_id: int,
    payload: PersonUpdate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).update_person(person_id, payload, current_user.id)
    return PersonRead.model_validate(person)
