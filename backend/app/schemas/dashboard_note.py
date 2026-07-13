from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.enums import UserRole


class DashboardNoteSiteRead(BaseModel):
    id: int
    site_number: str | None = None
    name: str

    model_config = {"from_attributes": True}


class DashboardNoteEmployeeRead(BaseModel):
    id: int
    display_name: str
    short_code: str

    model_config = {"from_attributes": True}


class DashboardNoteUserRead(BaseModel):
    id: int
    username: str
    display_name: str
    role: UserRole

    model_config = {"from_attributes": True}


class DashboardNoteCreate(BaseModel):
    text: str = Field(min_length=1)
    due_date: date | None = None
    site_id: int | None = None
    employee_id: int | None = None
    shared_with_user_id: int | None = None


class DashboardNoteUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=1)
    due_date: date | None = None
    completed: bool | None = None
    site_id: int | None = None
    employee_id: int | None = None
    shared_with_user_id: int | None = None


class DashboardNoteRead(BaseModel):
    id: int
    text: str
    due_date: date | None = None
    completed: bool
    completed_at: datetime | None = None
    site_id: int | None = None
    employee_id: int | None = None
    created_by_user_id: int
    shared_with_user_id: int | None = None
    share_revision: int
    shared_at: datetime | None = None
    site: DashboardNoteSiteRead | None = None
    employee: DashboardNoteEmployeeRead | None = None
    created_by: DashboardNoteUserRead
    shared_with: DashboardNoteUserRead | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
