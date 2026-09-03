from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator


class PersonHoursAbsenceBreakdownItem(BaseModel):
    absence_type: str
    minutes: int


class PersonHoursAccountEntryRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    person_id: int
    entry_type: str
    minutes_delta: int
    balance_after_minutes: int
    note: str
    iso_year: int | None = None
    iso_week: int | None = None
    weekly_work_minutes: int | None = None
    weekly_actual_minutes: int | None = None
    weekly_required_minutes: int | None = None
    weekly_overtime_absence_minutes: int | None = None
    weekly_absence_breakdown: list[PersonHoursAbsenceBreakdownItem] = Field(default_factory=list)
    created_by_user_id: int | None = None
    created_by_name: str | None = None
    created_at: datetime
    ledger_system: str = "legacy"
    effective_date: date | None = None
    source_type: str | None = None
    source_reference_id: str | None = None
    is_active: bool = True
    daily_target_minutes: int | None = None
    daily_work_minutes: int | None = None
    daily_credit_minutes: int | None = None
    daily_actual_minutes: int | None = None
    daily_absence_type: str | None = None

    @field_validator("weekly_absence_breakdown", mode="before")
    @classmethod
    def normalize_weekly_absence_breakdown(cls, value):
        return value or []


class PersonHoursAccountOpeningRead(BaseModel):
    id: int
    effective_date: date
    minutes: int
    entry_type: str = "legacy_opening_balance"
    confirmed_by_name: str | None = None
    confirmed_at: datetime
    note: str | None = None


class PersonHoursAccountRead(BaseModel):
    person_id: int
    current_balance_minutes: int
    opening_balance: PersonHoursAccountOpeningRead | None = None
    entries: list[PersonHoursAccountEntryRead]


class PersonHoursManualAdjustmentCreate(BaseModel):
    hours_delta: float = Field(ge=-500, le=500)
    effective_date: date
    note: str = Field(min_length=1, max_length=500)

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Grund ist Pflicht.")
        return cleaned


class PersonHoursPayoutCreate(BaseModel):
    hours: float = Field(gt=0, le=500)
    effective_date: date
    note: str | None = Field(default=None, max_length=500)

    @field_validator("note")
    @classmethod
    def clean_optional_note(cls, value: str | None) -> str | None:
        cleaned = value.strip() if isinstance(value, str) else None
        return cleaned or None
