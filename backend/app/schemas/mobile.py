from __future__ import annotations

from datetime import date as Date

from pydantic import BaseModel

from app.models.enums import AssignmentType, SiteStatus


class MobilePerson(BaseModel):
    id: int
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
