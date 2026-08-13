from __future__ import annotations

from datetime import date as Date, datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.models.enums import (
    AbsenceType,
    AssignmentType,
    SiteStatus,
    ToolIssueReason,
    ToolMaterialCategory,
)


class MobilePerson(BaseModel):
    id: int
    first_name: str | None = None
    last_name: str | None = None
    display_name: str
    phone: str | None = None
    email: str | None = None
    can_sign_measurements_immediately: bool = False


class MobileSite(BaseModel):
    id: int
    site_number: str | None = None
    name: str
    location: str | None = None
    address: str | None = None
    customer: str | None = None
    project_manager: MobilePerson | None = None
    status: SiteStatus
    info: str | None = None
    requires_extra_work_approval: bool = False


class MobileAssignment(BaseModel):
    id: int
    start_date: Date
    end_date: Date
    assignment_type: AssignmentType
    note: str | None = None
    person: MobilePerson
    site: MobileSite


class MobileAssignmentsResponse(BaseModel):
    start_date: Date
    end_date: Date
    assignments: list[MobileAssignment]


class MobileSelfPlanRequest(BaseModel):
    site_id: int
    work_date: Date


class MobilePersonalFileVehicle(BaseModel):
    id: int
    license_plate: str
    manufacturer: str


class MobilePersonalFileHoursAccount(BaseModel):
    current_balance_minutes: int
    last_entry_at: datetime | None = None


class MobileToolIssueSummary(BaseModel):
    id: int
    reason: ToolIssueReason
    status: str
    description: str
    created_at: datetime


class MobilePersonalFileTool(BaseModel):
    id: int
    category: ToolMaterialCategory
    beg_number: str | None = None
    manufacturer: str | None = None
    designation: str
    device_number: str | None = None
    item_date: Date | None = None
    open_issue_reports: list[MobileToolIssueSummary] = Field(default_factory=list)


class MobileToolIssueReportCreate(BaseModel):
    reason: ToolIssueReason
    request_id: UUID


class MobileToolIssueReportRead(BaseModel):
    id: int
    status: str
    created_at: datetime
    message: str
    already_reported: bool = False


class MobilePersonalFileResponse(BaseModel):
    current_year: int
    remaining_vacation_days: int
    total_vacation_days: int
    sick_days: int
    hours_account: MobilePersonalFileHoursAccount
    vehicle: MobilePersonalFileVehicle | None = None
    tool_count: int
    tool_preview: list[MobilePersonalFileTool]


class MobilePersonalFileAbsenceEntry(BaseModel):
    source_id: int
    absence_type: AbsenceType
    start_date: Date
    end_date: Date
    day_count: int = Field(ge=1)


class MobilePersonalFileAbsenceWeek(BaseModel):
    iso_year: int
    iso_week: int
    week_start: Date
    week_end: Date
    entries: list[MobilePersonalFileAbsenceEntry]


class MobilePersonalFileAbsenceResponse(BaseModel):
    year: int
    absence_type: AbsenceType
    remaining_vacation_days: int
    total_vacation_days: int
    taken_vacation_days: int
    sick_days: int
    weeks: list[MobilePersonalFileAbsenceWeek]
