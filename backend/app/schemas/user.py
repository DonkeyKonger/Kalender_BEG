from datetime import datetime

from pydantic import BaseModel, Field

from app.models.enums import UserRole


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=4, max_length=200)
    role: UserRole
    is_active: bool = True
    person_id: int | None = None


class UserUpdate(BaseModel):
    username: str | None = Field(default=None, min_length=1, max_length=80)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: UserRole | None = None
    is_active: bool | None = None
    person_id: int | None = None


class UserPasswordReset(BaseModel):
    password: str = Field(min_length=4, max_length=200)


class UserRead(BaseModel):
    id: int
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    must_change_password: bool
    last_admin_password_plain: str | None = None
    person_id: int | None = None
    last_login_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
