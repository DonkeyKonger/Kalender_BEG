from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.matrix import (
    MatrixCellPatch,
    MatrixMutationResponse,
    MatrixRangePatch,
    MatrixResponse,
)
from app.services.matrix_mutation_service import MatrixMutationService
from app.services.matrix_service import MatrixService

router = APIRouter(prefix="/matrix", tags=["matrix"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


@router.get("", response_model=MatrixResponse)
def get_matrix(
    start: date,
    end: date,
    include_weekends: bool = False,
    include_closed: bool = False,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> MatrixResponse:
    return MatrixService(db).get_matrix(
        start=start,
        end=end,
        include_weekends=include_weekends,
        include_closed=include_closed,
    )


@router.patch("/cell", response_model=MatrixMutationResponse)
def patch_matrix_cell(
    payload: MatrixCellPatch,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MatrixMutationResponse:
    return MatrixMutationResponse(
        **MatrixMutationService(db).patch_cell(payload, current_user.id)
    )


@router.patch("/range", response_model=MatrixMutationResponse)
def patch_matrix_range(
    payload: MatrixRangePatch,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MatrixMutationResponse:
    return MatrixMutationResponse(
        **MatrixMutationService(db).patch_range(payload, current_user.id)
    )
