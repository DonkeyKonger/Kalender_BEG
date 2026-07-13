from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_office_page, require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.dashboard_note import DashboardNoteRead
from app.schemas.matrix import (
    MatrixCellMarkPatch,
    MatrixCellPatch,
    MatrixMutationResponse,
    MatrixRangePatch,
    MatrixResponse,
    MatrixVersionResponse,
)
from app.services.dashboard_note_service import DashboardNoteService
from app.services.matrix_mutation_service import MatrixMutationService
from app.services.matrix_service import MatrixService

router = APIRouter(prefix="/matrix", tags=["matrix"])

CAN_READ = require_office_page("calendar", roles=(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE))
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


@router.get("", response_model=MatrixResponse)
def get_matrix(
    start: date,
    end: date,
    include_weekends: bool = False,
    include_closed: bool = False,
    year_view: bool = False,
    project_manager_person_id: int | None = None,
    _current_user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> MatrixResponse:
    return MatrixService(db).get_matrix(
        start=start,
        end=end,
        include_weekends=include_weekends,
        include_closed=include_closed,
        year_view=year_view,
        project_manager_person_id=project_manager_person_id,
    )


@router.get("/version", response_model=MatrixVersionResponse)
def get_matrix_version(
    start: date,
    end: date,
    include_closed: bool = False,
    year_view: bool = False,
    project_manager_person_id: int | None = None,
    _current_user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> MatrixVersionResponse:
    return MatrixService(db).get_version(
        start=start,
        end=end,
        include_closed=include_closed,
        year_view=year_view,
        project_manager_person_id=project_manager_person_id,
    )


@router.get("/sites/{site_id}/notes", response_model=list[DashboardNoteRead])
def list_matrix_site_notes(
    site_id: int,
    completed: bool | None = None,
    _current_user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[DashboardNoteRead]:
    notes = DashboardNoteService(db).list_site_notes(
        site_id=site_id,
        completed=completed,
    )
    return [DashboardNoteRead.model_validate(note) for note in notes]


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


@router.patch("/cell-mark", response_model=MatrixMutationResponse)
def patch_matrix_cell_mark(
    payload: MatrixCellMarkPatch,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MatrixMutationResponse:
    return MatrixMutationResponse(
        **MatrixMutationService(db).patch_cell_mark(payload, current_user.id)
    )
