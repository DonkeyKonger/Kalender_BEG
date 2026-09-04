from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field, model_validator


class PayrollMonthBlocker(BaseModel):
    code: str
    message: str
    person_id: int | None = None
    work_date: date | None = None
    work_date_end: date | None = None


class PayrollMonthPersonApprovalSummary(BaseModel):
    approved_count: int
    total_count: int


class PayrollMonthPersonApprovalRead(BaseModel):
    person_id: int
    person_name: str
    status: str
    approval_version: int
    approved_at: datetime | None = None
    approved_by_name: str | None = None
    reopened_at: datetime | None = None
    reopened_by_name: str | None = None
    reopen_reason: str | None = None
    blocker_count: int
    blockers: list[PayrollMonthBlocker] = Field(default_factory=list)
    has_blocking_technical_error: bool
    export_ready: bool
    export_status: str
    export_message: str | None = None
    can_approve: bool
    can_reopen: bool


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
    person_approval_summary: PayrollMonthPersonApprovalSummary | None = None
    person_approvals: list[PayrollMonthPersonApprovalRead] = Field(default_factory=list)


class PayrollMonthPersonApprovalRequest(BaseModel):
    confirmed: bool
    acknowledged_blocker_count: int = Field(ge=0)


class PayrollMonthPersonReopenRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def clean_reason(self):
        self.reason = self.reason.strip()
        if not self.reason:
            raise ValueError("Eine Begründung ist Pflicht.")
        return self


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
