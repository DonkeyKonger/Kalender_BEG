from __future__ import annotations

from datetime import date as Date, datetime, time as Time

from pydantic import BaseModel, Field, field_validator, model_validator


TIME_ENTRY_STATUSES = {"draft", "submitted", "reviewed"}
TIME_ENTRY_SOURCES = {"manual"}


class TimeEntryBase(BaseModel):
    person_id: int
    site_id: int | None = None
    assignment_id: int | None = None
    work_date: Date
    start_time: Time | None = None
    end_time: Time | None = None
    break_minutes: int | None = Field(default=0, ge=0)
    travel_minutes: int | None = Field(default=0, ge=0)
    work_minutes: int | None = Field(default=None, ge=0)
    note: str | None = None
    source: str = "manual"
    status: str = "draft"

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        cleaned = value.strip() or "manual"
        if cleaned not in TIME_ENTRY_SOURCES:
            raise ValueError("source ist nicht erlaubt.")
        return cleaned

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        cleaned = value.strip() or "draft"
        if cleaned not in TIME_ENTRY_STATUSES:
            raise ValueError("status ist nicht erlaubt.")
        return cleaned

    @model_validator(mode="after")
    def validate_time_basis(self):
        if self.work_minutes is None and not (self.start_time and self.end_time):
            raise ValueError("Arbeitszeit braucht work_minutes oder Start-/Endzeit.")
        return self


class TimeEntryCreate(TimeEntryBase):
    pass


class TimeEntryUpdate(BaseModel):
    person_id: int | None = None
    site_id: int | None = None
    assignment_id: int | None = None
    work_date: Date | None = None
    start_time: Time | None = None
    end_time: Time | None = None
    break_minutes: int | None = Field(default=None, ge=0)
    travel_minutes: int | None = Field(default=None, ge=0)
    work_minutes: int | None = Field(default=None, ge=0)
    note: str | None = None
    source: str | None = None
    status: str | None = None

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip() or "manual"
        if cleaned not in TIME_ENTRY_SOURCES:
            raise ValueError("source ist nicht erlaubt.")
        return cleaned

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip() or "draft"
        if cleaned not in TIME_ENTRY_STATUSES:
            raise ValueError("status ist nicht erlaubt.")
        return cleaned


class TimeEntryRead(BaseModel):
    id: int
    person_id: int
    person_name: str
    site_id: int | None = None
    site_name: str | None = None
    site_number: str | None = None
    assignment_id: int | None = None
    work_date: Date
    start_time: Time | None = None
    end_time: Time | None = None
    break_minutes: int
    travel_minutes: int
    work_minutes: int
    note: str | None = None
    source: str
    status: str
    gps_status: str | None = None
    gps_matched_points: int | None = None
    gps_total_points: int | None = None
    gps_first_seen_at: datetime | None = None
    gps_last_seen_at: datetime | None = None
    gps_work_minutes: int | None = None
    created_by_user_id: int | None = None
    reviewed_by_user_id: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
