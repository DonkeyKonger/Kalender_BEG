from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin
from app.core.database import get_db
from app.models.user import User
from app.schemas.user import UserCreate, UserPasswordReset, UserRead, UserUpdate
from app.services.user_service import UserService

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserRead])
def list_users(
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[UserRead]:
    return [UserRead.model_validate(user) for user in UserService(db).list_users()]


@router.post("", response_model=UserRead, status_code=201)
def create_user(
    payload: UserCreate,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserRead:
    user = UserService(db).create_user(payload)
    return UserRead.model_validate(user)


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdate,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserRead:
    user = UserService(db).update_user(user_id, payload, current_user.id)
    return UserRead.model_validate(user)


@router.post("/{user_id}/reset-password", response_model=UserRead)
def reset_user_password(
    user_id: int,
    payload: UserPasswordReset,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserRead:
    user = UserService(db).reset_password(user_id, payload)
    return UserRead.model_validate(user)


@router.post("/{user_id}/disable", response_model=UserRead)
def disable_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserRead:
    user = UserService(db).disable_user(user_id, current_user.id)
    return UserRead.model_validate(user)
