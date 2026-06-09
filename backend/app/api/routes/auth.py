from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, oauth2_scheme
from app.core.config import settings
from app.core.database import get_db
from app.core.security import decode_access_token
from app.schemas.auth import CurrentUserResponse, LoginRequest, PasswordChangeRequest, TokenResponse
from app.repositories.user_repository import UserRepository
from app.services.auth_service import AuthenticationError, AuthService, InactiveUserError
from app.services.user_service import UserService

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    auth_service = AuthService(db)
    try:
        user = auth_service.authenticate(payload.username, payload.password)
    except AuthenticationError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Anmeldename oder Passwort ist falsch.",
        ) from None
    except InactiveUserError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Der Benutzer ist deaktiviert.",
        ) from None

    return TokenResponse(
        access_token=auth_service.create_user_token(user),
        must_change_password=getattr(user, "must_change_password", False),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> TokenResponse:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Sitzung konnte nicht erneuert werden. Bitte erneut anmelden.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token, verify_exp=False)
        user_id = int(payload.get("sub", ""))
        expires_at = datetime.fromtimestamp(float(payload.get("exp")), UTC)
    except (jwt.PyJWTError, TypeError, ValueError, OSError):
        raise credentials_error from None

    now = datetime.now(UTC)
    if expires_at < now:
        refresh_until = expires_at + timedelta(
            minutes=max(settings.access_token_refresh_grace_minutes, 0)
        )
        if refresh_until < now:
            raise credentials_error

    user = UserRepository(db).get_by_id(user_id)
    if user is None:
        raise credentials_error
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Der Benutzer ist deaktiviert.",
        )

    return TokenResponse(
        access_token=AuthService(db).create_user_token(user),
        must_change_password=getattr(user, "must_change_password", False),
    )


@router.post("/change-password", response_model=CurrentUserResponse)
def change_password(
    payload: PasswordChangeRequest,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CurrentUserResponse:
    user = UserService(db).change_own_password(current_user.id, payload.new_password)
    return CurrentUserResponse.model_validate(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=CurrentUserResponse)
def me(current_user=Depends(get_current_user)) -> CurrentUserResponse:
    return CurrentUserResponse.model_validate(current_user)
