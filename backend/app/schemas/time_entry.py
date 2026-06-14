from __future__ import annotations

from datetime import date as Date, datetime, time as Time

from pydantic import BaseModel, Field, field_validator, model_validator


TIME_ENTRY_STATUSES = {"draft", "submitted", "reviewed"}
TIME_ENTRY_SOURCES = {"manual"}
TIME_REVIEW_STATUSES = {
    "open",
    "manually_approved",
    "corrected",
    "not_verifiable",
    "clarification",
    "auto_closed_by_deadline",
}
TIME_REVIEW_METHODS = {
    "accept_manual",
    "accept_gps",
    "manual_confirmed",
    "manual_correction",
    "assign_site",
    "mark_not_verifiable",
    "clarification",
    "deadline",
}
TIME_REVIEW_DECISIONS = {
    "accept_manual",
    "accept_gps",
    "corrected",
    "assign_site",
    "mark_not_verifiable",
    "mark_clarification",
}


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


class TimeEntryCorrection(BaseModel):
    corrected_work_minutes: int = Field(ge=0)


class TimeEntryReviewDecision(BaseModel):
    decision: str
    final_work_minutes: int | None = Field(default=None, ge=0)
    reviewed_site_id: int | None = None

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, value: str) -> str:
        cleaned = value.strip()
        if cleaned not in TIME_REVIEW_DECISIONS:
            raise ValueError("review decision ist nicht erlaubt.")
        return cleaned


class TimeEntryWeeklyReviewCreate(BaseModel):
    person_id: int
    iso_year: int = Field(ge=2000, le=2100)
    iso_week: int = Field(ge=1, le=53)


class TimeEntryWeeklyReviewRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    person_id: int
    iso_year: int
    iso_week: int
    reviewed_by_user_id: int | None = None
    reviewed_at: datetime
    created_at: datetime
    updated_at: datetime


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
    original_work_minutes: int | None = None
    corrected_work_minutes: int | None = None
    note: str | None = None
    source: str
    status: str
    time_review_status: str = "open"
    time_review_method: str | None = None
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
    review_source: str = "manual"
    is_gps_suggestion: bool = False
    has_manual_entry: bool = True
    gps_suggestion_key: str | None = None
    planned_site_labels: list[str] = Field(default_factory=list)
    gps_detected_site_id: int | None = None
    gps_detected_site_name: str | None = None
    gps_detected_site_number: str | None = None
    gps_detected_location_type: str | None = None
    planned_vs_gps_mismatch: bool = False
    manual_vs_planned_mismatch: bool = False
    manual_vs_gps_mismatch: bool = False
    gps_not_checkable: bool = False
    mismatch_notice: str | None = None
    review_notices: list[str] = Field(default_factory=list)
