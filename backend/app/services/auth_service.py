from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.security import create_access_token, verify_password
from app.models.user import User
from app.repositories.user_repository import UserRepository


class AuthenticationError(Exception):
    pass


class InactiveUserError(Exception):
    pass


class AuthService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)

    def authenticate(self, username: str, password: str) -> User:
        user = self.users.get_by_username(username)
        if user is None or not verify_password(password, user.password_hash):
            raise AuthenticationError
        if not user.is_active:
            raise InactiveUserError

        user.last_login_at = datetime.now(UTC)
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def create_user_token(self, user: User) -> str:
        return create_access_token(subject=str(user.id))
