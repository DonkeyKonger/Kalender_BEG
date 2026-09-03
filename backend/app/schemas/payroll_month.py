from datetime import date, datetime

from pydantic import BaseModel, Field, model_validator


class PayrollMonthBlocker(BaseModel):
    code: str
    message: str
    person_id: int | None = None
    work_date: date | None = None


class PayrollMonthStatusRead(BaseModel):
    year: int
    month: int
    status: str
    snapshot_id: int | None = None
    snapshot_version: int | None = None
    locked_at: datetime | None = None
    locked_by_name: str | None = None
    can_lock: bool
    can_reopen: bool
    artifacts_ready: bool
    blockers: list[PayrollMonthBlocker] = Field(default_factory=list)


class PayrollMonthLockRequest(BaseModel):
    confirmed: bool


class PayrollMonthReopenRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def clean_reason(self):
        self.reason = self.reason.strip()
        if not self.reason:
            raise ValueError("Eine Begründung ist Pflicht.")
        return self


class PayrollMonthAuditRead(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    snapshot_id: int | None = None
    action: str
    status_before: str
    status_after: str
    reason: str | None = None
    details_json: dict | None = None
    user_id: int | None = None
    created_at: datetime
