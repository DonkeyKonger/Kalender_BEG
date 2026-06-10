from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ExtraWorkTicketCreate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    notes: str | None = Field(default=None, max_length=2000)


class ExtraWorkTicketRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    sequence_number: int
    display_number: str
    title: str | None
    status: str
    created_by_user_id: int | None
    submitted_by_user_id: int | None
    submitted_at: datetime | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
