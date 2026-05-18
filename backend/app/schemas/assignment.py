from __future__ import annotations

from datetime import date as Date, datetime

from pydantic import BaseModel, Field, model_validator

from app.models.enums import AssignmentType


class DateRangeModel(BaseModel):
    start_date: Date
    end_date: Date

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date darf nicht vor start_date liegen.")
        return self


class AssignmentCreate(DateRangeModel):
    site_id: int
    person_id: int
    assignment_type: AssignmentType = AssignmentType.REGULAR
    note: str | None = None


class AssignmentUpdate(BaseModel):
    site_id: int | None = None
    person_id: int | None = None
    start_date: Date | None = None
    end_date: Date | None = None
    assignment_type: AssignmentType | None = None
    note: str | None = None

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date darf nicht vor start_date liegen.")
        return self


class ConflictMessageRead(BaseModel):
    severity: str
    code: str
    message: str
    date: Date | None = None


class AssignmentRead(BaseModel):
    id: int
    site_id: int
    person_id: int
    start_date: Date
    end_date: Date
    assignment_type: AssignmentType
    note: str | None = None
    created_by_user_id: int | None = None
    updated_by_user_id: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AssignmentMutationResponse(BaseModel):
    assignment: AssignmentRead
    warnings: list[ConflictMessageRead] = Field(default_factory=list)
    infos: list[ConflictMessageRead] = Field(default_factory=list)
