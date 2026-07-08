from pydantic import BaseModel, Field, field_validator

from app.core.office_permissions import normalize_office_page_permissions as normalize_permissions
from app.models.enums import UserRole


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    must_change_password: bool = False


class PasswordChangeRequest(BaseModel):
    new_password: str = Field(min_length=4, max_length=200)


class CurrentUserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    must_change_password: bool
    office_page_permissions: list[str] = Field(default_factory=list)
    person_id: int | None = None

    model_config = {"from_attributes": True}

    @field_validator("office_page_permissions", mode="before")
    @classmethod
    def normalize_office_page_permissions(cls, value) -> list[str]:
        return normalize_permissions(value or [])
