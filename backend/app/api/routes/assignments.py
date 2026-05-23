from datetime import date

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.assignment import (
    AssignmentCreate,
    AssignmentMutationResponse,
    AssignmentRead,
    AssignmentSegmentMove,
    AssignmentUpdate,
    ConflictMessageRead,
)
from app.services.assignment_service import AssignmentMutationResult, AssignmentService

router = APIRouter(prefix="/assignments", tags=["assignments"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


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


@router.delete("/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assignment(
    assignment_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> Response:
    AssignmentService(db).delete_assignment(assignment_id, current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _mutation_response(result: AssignmentMutationResult) -> AssignmentMutationResponse:
    return AssignmentMutationResponse(
        assignment=AssignmentRead.model_validate(result.assignment),
        warnings=[ConflictMessageRead(**item.to_dict()) for item in result.warnings],
        infos=[ConflictMessageRead(**item.to_dict()) for item in result.infos],
    )
