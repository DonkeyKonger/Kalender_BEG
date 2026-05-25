from fastapi import APIRouter, Depends

from app.api.dependencies import require_admin
from app.models.user import User
from app.schemas.microsoft_graph import (
    MicrosoftGraphConnectionTestResponse,
    MicrosoftGraphCreateTestFolderResponse,
)
from app.services.project_storage_service import ProjectStorageService

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
