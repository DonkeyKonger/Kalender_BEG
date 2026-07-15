from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page, require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.person import (
    ExternalPersonCreate,
    PersonCreate,
    PersonGeocodeSearchResult,
    PersonMapResponse,
    PersonRead,
    PersonRemovePlan,
    PersonRemoveResponse,
    PersonToolMaterialRead,
    PersonUpdate,
)
from app.schemas.person_hours_account import (
    PersonHoursAccountRead,
    PersonHoursManualAdjustmentCreate,
    PersonHoursPayoutCreate,
)
from app.services.geo_service import search_geocoding_candidates
from app.services.person_hours_account_service import PersonHoursAccountService
from app.services.person_service import PersonService
from app.services.tool_material_service import ToolMaterialService

router = APIRouter(prefix="/persons", tags=["persons"])

CAN_READ = require_business_page(
    "employees",
    "payroll",
    "calendar",
    "absences",
)
CAN_MAP_READ = require_business_page("map")
CAN_WRITE = require_business_page("employees")
CAN_EMPLOYEE_READ = require_business_page("employees")
CAN_EXTERNAL_WRITE = require_business_page("employees", "calendar")
CAN_ADMIN = require_roles(UserRole.ADMIN)
CAN_HOURS_ACCOUNT_WRITE = require_business_page(
    "employees",
    "payroll",
)


@router.get("", response_model=list[PersonRead])
def list_persons(
    is_active: bool | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[PersonRead]:
    people = PersonService(db).list_people(is_active=is_active)
    return [person_read(person) for person in people if person.deleted_at is None]


@router.get("/map", response_model=PersonMapResponse)
def person_map(
    _user=Depends(CAN_MAP_READ),
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


@router.get("/{person_id}/tool-material-items", response_model=list[PersonToolMaterialRead])
def list_person_tool_material_items(
    person_id: int,
    _user=Depends(CAN_EMPLOYEE_READ),
    db: Session = Depends(get_db),
) -> list[PersonToolMaterialRead]:
    return ToolMaterialService(db).list_person_assignments(person_id)


@router.get("/{person_id}/hours-account", response_model=PersonHoursAccountRead)
def get_person_hours_account(
    person_id: int,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> PersonHoursAccountRead:
    return PersonHoursAccountService(db).get_account(person_id=person_id)


@router.post("/{person_id}/hours-account/manual-adjustment", response_model=PersonHoursAccountRead)
def create_person_hours_manual_adjustment(
    person_id: int,
    payload: PersonHoursManualAdjustmentCreate,
    current_user=Depends(CAN_HOURS_ACCOUNT_WRITE),
    db: Session = Depends(get_db),
) -> PersonHoursAccountRead:
    return PersonHoursAccountService(db).create_manual_adjustment(
        person_id=person_id,
        hours_delta=payload.hours_delta,
        note=payload.note,
        current_user=current_user,
    )


@router.post("/{person_id}/hours-account/payout", response_model=PersonHoursAccountRead)
def create_person_hours_payout(
    person_id: int,
    payload: PersonHoursPayoutCreate,
    current_user=Depends(CAN_HOURS_ACCOUNT_WRITE),
    db: Session = Depends(get_db),
) -> PersonHoursAccountRead:
    return PersonHoursAccountService(db).create_payout(
        person_id=person_id,
        hours=payload.hours,
        note=payload.note,
        current_user=current_user,
    )


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


@router.delete("/{person_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_person(
    person_id: int,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> Response:
    PersonService(db).delete_person(person_id, current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("", response_model=PersonRead, status_code=201)
def create_person(
    payload: PersonCreate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).create_person(payload, current_user.id)
    return person_read(person)


@router.post("/external", response_model=PersonRead, status_code=201)
def create_external_person(
    payload: ExternalPersonCreate,
    current_user=Depends(CAN_EXTERNAL_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).create_external_person(payload, current_user.id)
    return person_read(person)


@router.patch("/{person_id}", response_model=PersonRead)
def update_person(
    person_id: int,
    payload: PersonUpdate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> PersonRead:
    person = PersonService(db).update_person(person_id, payload, current_user.id)
    return person_read(person)


def person_read(person) -> PersonRead:
    user_roles = sorted({
        user.role
        for user in getattr(person, "users", [])
        if user.is_active
    })
    return PersonRead.model_validate(person).model_copy(update={"user_roles": user_roles})
