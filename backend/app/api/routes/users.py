from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin
from app.core.database import get_db
from app.repositories.user_repository import UserRepository
from app.schemas.user import UserRead

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserRead])
def list_users(
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[UserRead]:
    return [UserRead.model_validate(user) for user in UserRepository(db).list_users()]
