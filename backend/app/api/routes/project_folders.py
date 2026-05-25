from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.project_folder import ProjectFolderRead
from app.services.project_folder_service import ProjectFolderService

router = APIRouter(prefix="/project-folders", tags=["project-folders"])

CAN_FOLDER_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)


@router.get("/{folder_id}", response_model=ProjectFolderRead)
def get_project_folder(
    folder_id: int,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> ProjectFolderRead:
    folder = ProjectFolderService(db).get_project_folder(folder_id, current_user)
    return ProjectFolderRead.model_validate(folder)
