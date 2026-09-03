from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.payroll_daily_ledger import (
    PAYROLL_LEDGER_CUTOVER_DATE,
    PAYROLL_LEDGER_OPENING_DATE,
)


class PayrollWeeklyPlanUpsert(BaseModel):
    valid_from: date = PAYROLL_LEDGER_CUTOVER_DATE
    valid_to: date | None = None
    weekday_minutes: list[int] = Field(min_length=7, max_length=7)
    note: str | None = Field(default=None, max_length=500)
    confirm: bool = True

    @field_validator("weekday_minutes")
    @classmethod
    def validate_weekday_minutes(cls, value: list[int]) -> list[int]:
        if any(minutes < 0 or minutes > 24 * 60 for minutes in value):
            raise ValueError("Sollminuten müssen zwischen 0 und 1440 liegen.")
        return value

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str | None) -> str | None:
        cleaned = value.strip() if isinstance(value, str) else None
        return cleaned or None

    @model_validator(mode="after")
    def validate_range(self) -> "PayrollWeeklyPlanUpsert":
        if self.valid_from < PAYROLL_LEDGER_CUTOVER_DATE:
            raise ValueError("Wochenpläne dürfen nicht vor dem 01.08.2026 beginnen.")
        if self.valid_to is not None and self.valid_to < self.valid_from:
            raise ValueError("Das Gültigkeitsende liegt vor dem Gültigkeitsbeginn.")
        return self


class PayrollOpeningBalanceUpsert(BaseModel):
    effective_date: date = PAYROLL_LEDGER_OPENING_DATE
    minutes: int
    note: str | None = Field(default=None, max_length=500)
    confirm: bool = True

    @field_validator("effective_date")
    @classmethod
    def validate_effective_date(cls, value: date) -> date:
        if value != PAYROLL_LEDGER_OPENING_DATE:
            raise ValueError("Der Eröffnungssaldo muss den Stichtag 31.07.2026 verwenden.")
        return value

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str | None) -> str | None:
        cleaned = value.strip() if isinstance(value, str) else None
        return cleaned or None


class PayrollWeeklyPlanRead(BaseModel):
    id: int
    valid_from: date
    valid_to: date | None
    weekday_minutes: list[int]
    weekly_minutes: int
    contract_weekly_minutes: int | None
    is_confirmed: bool
    confirmed_by_name: str | None = None
    confirmed_at: datetime | None = None
    note: str | None = None


class PayrollOpeningBalanceRead(BaseModel):
    id: int
    effective_date: date
    minutes: int
    is_confirmed: bool
    confirmed_by_name: str | None = None
    confirmed_at: datetime | None = None
    note: str | None = None


class PayrollSetupWorkerRead(BaseModel):
    person_id: int
    person_name: str
    weekly_hours: float | None
    plan: PayrollWeeklyPlanRead | None
    opening_balance: PayrollOpeningBalanceRead | None
    historical_balance_minutes: int


class PayrollSetupRead(BaseModel):
    effective_date: date
    is_ready: bool
    workers: list[PayrollSetupWorkerRead]
