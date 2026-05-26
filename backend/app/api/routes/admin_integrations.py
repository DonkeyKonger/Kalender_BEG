from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db, require_admin
from app.models.user import User
from app.schemas.microsoft_graph import (
    MicrosoftGraphBackfillProjectFoldersResponse,
    MicrosoftGraphConnectionTestResponse,
    MicrosoftGraphCreateTestFolderResponse,
)
from app.services.project_storage_service import ProjectStorageService
from app.services.site_service import SiteService

router = APIRouter(prefix="/admin/integrations/microsoft-graph", tags=["admin-integrations"])


@router.get("/test", response_model=MicrosoftGraphConnectionTestResponse)
def test_microsoft_graph_connection(
    _current_user: User = Depends(require_admin),
) -> MicrosoftGraphConnectionTestResponse:
    result = ProjectStorageService().test_project_storage_connection()
    return MicrosoftGraphConnectionTestResponse.model_validate(result)


@router.post("/create-test-project-folder", response_model=MicrosoftGraphCreateTestFolderResponse)
def create_microsoft_graph_test_project_folder(
    _current_user: User = Depends(require_admin),
) -> MicrosoftGraphCreateTestFolderResponse:
    result = ProjectStorageService().create_test_project_folder()
    return MicrosoftGraphCreateTestFolderResponse.model_validate(result)


@router.post(
    "/backfill-project-folders", response_model=MicrosoftGraphBackfillProjectFoldersResponse
)
def backfill_microsoft_graph_project_folders(
    limit: int = Query(default=10, ge=1, le=25),
    _current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MicrosoftGraphBackfillProjectFoldersResponse:
    result = SiteService(db).backfill_project_folders(limit=limit)
    return MicrosoftGraphBackfillProjectFoldersResponse.model_validate(result)
