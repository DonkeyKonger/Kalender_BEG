from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user import User


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, user_id: int) -> User | None:
        return self.db.get(User, user_id)

    def get_by_username(self, username: str) -> User | None:
        statement = select(User).where(User.username == username)
        return self.db.scalar(statement)

    def list_users(self) -> list[User]:
        statement = select(User).order_by(User.username)
        return list(self.db.scalars(statement))

    def add(self, user: User) -> User:
        self.db.add(user)
        self.db.flush()
        return user
