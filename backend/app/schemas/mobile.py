from __future__ import annotations

from datetime import date as Date

from pydantic import BaseModel

from app.models.enums import AssignmentType, SiteStatus, ToolMaterialCategory


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
    name: str
    vehicle_registration: str | None = None
    fleet_number: str | None = None


class MobilePersonalFileTool(BaseModel):
    category: ToolMaterialCategory
    beg_number: str | None = None
    manufacturer: str | None = None
    designation: str
    item_date: Date | None = None


class MobilePersonalFileResponse(BaseModel):
    current_year: int
    remaining_vacation_days: int
    total_vacation_days: int
    sick_days: int
    vehicle: MobilePersonalFileVehicle | None = None
    tool_count: int
    tool_preview: list[MobilePersonalFileTool]
