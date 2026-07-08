from collections.abc import Callable

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.office_permissions import OFFICE_PAGE_PERMISSION_SET, office_user_can_access
from app.core.security import decode_access_token
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.user_repository import UserRepository

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Anmeldung erforderlich.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token)
        user_id = int(payload.get("sub", ""))
    except (jwt.PyJWTError, ValueError):
        raise credentials_error from None

    user = UserRepository(db).get_by_id(user_id)
    if user is None:
        raise credentials_error
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Der Benutzer ist deaktiviert.",
        )
    return user


def require_roles(*roles: UserRole) -> Callable[[User], User]:
    def dependency(current_user: User = Depends(get_current_app_user)) -> User:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Keine Berechtigung fuer diese Aktion.",
            )
        return current_user

    return dependency


def require_office_page(page_key: str, *additional_page_keys: str, roles: tuple[UserRole, ...]) -> Callable[[User], User]:
    page_keys = (page_key, *additional_page_keys)
    invalid = [key for key in page_keys if key not in OFFICE_PAGE_PERMISSION_SET]
    if invalid:
        raise ValueError(f"Unknown office page permission: {invalid[0]}")

    def dependency(current_user: User = Depends(require_roles(*roles))) -> User:
        if not office_user_can_access(current_user, *page_keys):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Keine Berechtigung für diese Seite.",
            )
        return current_user

    return dependency


def get_current_app_user(current_user: User = Depends(get_current_user)) -> User:
    if getattr(current_user, "must_change_password", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Passwortwechsel erforderlich.",
        )
    return current_user


def require_admin(current_user: User = Depends(require_roles(UserRole.ADMIN))) -> User:
    return current_user
