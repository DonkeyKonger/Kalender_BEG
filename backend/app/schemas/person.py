from datetime import datetime

from pydantic import BaseModel, Field

from app.models.enums import PersonType


class PersonBase(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    short_code: str = Field(min_length=1, max_length=30)
    person_type: PersonType = PersonType.INTERNAL
    is_active: bool = True
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=80)
    notes: str | None = None


class PersonCreate(PersonBase):
    pass


class PersonUpdate(BaseModel):
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    short_code: str | None = Field(default=None, min_length=1, max_length=30)
    person_type: PersonType | None = None
    is_active: bool | None = None
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=80)
    notes: str | None = None


class PersonRead(PersonBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
