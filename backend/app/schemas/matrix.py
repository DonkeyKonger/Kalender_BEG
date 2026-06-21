from __future__ import annotations

from datetime import date as Date

from pydantic import BaseModel, Field

from app.models.enums import AbsenceType, AssignmentType, MatrixCellMark, PersonType, SiteStatus


class MatrixDay(BaseModel):
    date: Date
    weekday: int
    is_weekend: bool


class MatrixPerson(BaseModel):
    id: int
    display_name: str
    short_code: str
    person_type: PersonType


class MatrixAssignment(BaseModel):
    id: int
    person: MatrixPerson
    start_date: Date
    end_date: Date
    assignment_type: AssignmentType
    note: str | None = None


class MatrixAbsence(BaseModel):
    person: MatrixPerson
    absence_type: AbsenceType
    start_date: Date
    end_date: Date
    note: str | None = None


class MatrixCell(BaseModel):
    date: Date
    assignments: list[MatrixAssignment]
    absences: list[MatrixAbsence]
    mark: MatrixCellMark | None = None
    conflict_level: str = "none"
    conflict_reason: str | None = None
    conflict_codes: list[str] = Field(default_factory=list)


class MatrixSite(BaseModel):
    id: int
    site_number: str | None = None
    name: str
    location: str | None = None
    customer: str | None = None
    project_manager_person_id: int | None = None
    project_manager: MatrixPerson | None = None
    status: SiteStatus
    info: str | None = None
    color: str | None = None

    model_config = {"from_attributes": True}


class MatrixRow(BaseModel):
    site: MatrixSite
    cells: list[MatrixCell]


class MatrixResponse(BaseModel):
    start_date: Date
    end_date: Date
    days: list[MatrixDay]
    project_managers: list[MatrixPerson] = Field(default_factory=list)
    rows: list[MatrixRow]


class MatrixEntryInput(BaseModel):
    person_id: int | None = None
    external_name: str | None = None


class MatrixCellPatch(BaseModel):
    site_id: int
    date: Date
    entries: list[MatrixEntryInput]


class MatrixRangePatch(BaseModel):
    site_id: int
    start_date: Date
    end_date: Date
    entries: list[MatrixEntryInput]


class MatrixCellMarkPatch(BaseModel):
    site_id: int
    date: Date
    mark: MatrixCellMark | None = None


class MatrixConflictMessage(BaseModel):
    severity: str
    code: str
    message: str
    date: Date | None = None


class MatrixMutationResponse(BaseModel):
    warnings: list[MatrixConflictMessage] = Field(default_factory=list)
    infos: list[MatrixConflictMessage] = Field(default_factory=list)
    updated_cells: list[MatrixCell] = Field(default_factory=list)
