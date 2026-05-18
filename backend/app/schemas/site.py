from datetime import datetime

from pydantic import BaseModel, Field

from app.models.enums import SiteStatus


class SiteBase(BaseModel):
    site_number: str | None = Field(default=None, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    customer: str | None = Field(default=None, max_length=200)
    project_manager_person_id: int | None = None
    status: SiteStatus = SiteStatus.ACTIVE
    info: str | None = None
    color: str | None = Field(default=None, max_length=30)


class SiteCreate(SiteBase):
    pass


class SiteUpdate(BaseModel):
    site_number: str | None = Field(default=None, max_length=80)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    customer: str | None = Field(default=None, max_length=200)
    project_manager_person_id: int | None = None
    status: SiteStatus | None = None
    info: str | None = None
    color: str | None = Field(default=None, max_length=30)


class SiteRead(SiteBase):
    id: int
    closed_at: datetime | None = None
    closed_by_user_id: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
