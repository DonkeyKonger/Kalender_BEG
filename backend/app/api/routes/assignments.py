from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page
from app.core.database import get_db
from app.models.user import User
from app.schemas.assignment import (
    AssignmentCreate,
    AssignmentMutationResponse,
    AssignmentRead,
    AssignmentSegmentMove,
    AssignmentUpdatedSiteCells,
    AssignmentUpdate,
    ConflictMessageRead,
)
from app.services.assignment_service import AssignmentMutationResult, AssignmentService

router = APIRouter(prefix="/assignments", tags=["assignments"])

CAN_READ = require_business_page("calendar")
CAN_WRITE = require_business_page("calendar")


@router.get("", response_model=list[AssignmentRead])
def list_assignments(
    start: date | None = None,
    end: date | None = None,
    person_id: int | None = None,
    site_id: int | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[AssignmentRead]:
    assignments = AssignmentService(db).list_assignments(
        start=start,
        end=end,
        person_id=person_id,
        site_id=site_id,
    )
    return [AssignmentRead.model_validate(item) for item in assignments]


@router.post("", response_model=AssignmentMutationResponse, status_code=201)
def create_assignment(
    payload: AssignmentCreate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AssignmentMutationResponse:
    result = AssignmentService(db).create_assignment(payload, current_user.id)
    return _mutation_response(result)


@router.patch("/{assignment_id}", response_model=AssignmentMutationResponse)
def update_assignment(
    assignment_id: int,
    payload: AssignmentUpdate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AssignmentMutationResponse:
    result = AssignmentService(db).update_assignment(assignment_id, payload, current_user.id)
    return _mutation_response(result)


@router.post("/{assignment_id}/move-segment", response_model=AssignmentMutationResponse)
def move_assignment_segment(
    assignment_id: int,
    payload: AssignmentSegmentMove,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AssignmentMutationResponse:
    result = AssignmentService(db).move_assignment_segment(assignment_id, payload, current_user.id)
    return _mutation_response(result)


@router.delete("/{assignment_id}", response_model=AssignmentMutationResponse)
def delete_assignment(
    assignment_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AssignmentMutationResponse:
    result = AssignmentService(db).delete_assignment(assignment_id, current_user.id)
    return _mutation_response(result)


@router.delete("/{assignment_id}/days/{target_date}", response_model=AssignmentMutationResponse)
def delete_assignment_day(
    assignment_id: int,
    target_date: date,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> AssignmentMutationResponse:
    result = AssignmentService(db).delete_assignment_day(assignment_id, target_date, current_user.id)
    return _mutation_response(result)


def _mutation_response(result: AssignmentMutationResult) -> AssignmentMutationResponse:
    return AssignmentMutationResponse(
        assignment=AssignmentRead.model_validate(result.assignment),
        warnings=[ConflictMessageRead(**item.to_dict()) for item in result.warnings],
        infos=[ConflictMessageRead(**item.to_dict()) for item in result.infos],
        updated_site_cells=[
            AssignmentUpdatedSiteCells(site_id=item.site_id, cells=item.cells)
            for item in result.updated_site_cells
        ],
    )
