from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.office_permissions import normalize_office_page_permissions
from app.models.enums import UserRole


class OfficePagePermissionsMixin(BaseModel):
    office_page_permissions: list[str] = Field(default_factory=list)

    @field_validator("office_page_permissions")
    @classmethod
    def validate_office_page_permissions(cls, value: list[str]) -> list[str]:
        try:
            return normalize_office_page_permissions(value)
        except ValueError as error:
            raise ValueError(str(error)) from error


class UserCreate(OfficePagePermissionsMixin):
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
    office_page_permissions: list[str] | None = None

    @field_validator("office_page_permissions")
    @classmethod
    def validate_office_page_permissions(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        try:
            return normalize_office_page_permissions(value)
        except ValueError as error:
            raise ValueError(str(error)) from error


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
    office_page_permissions: list[str] = Field(default_factory=list)
    person_id: int | None = None
    last_login_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @field_validator("office_page_permissions", mode="before")
    @classmethod
    def normalize_read_office_page_permissions(cls, value) -> list[str]:
        return normalize_office_page_permissions(value or [])
