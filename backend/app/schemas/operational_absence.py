from datetime import date as Date
from datetime import datetime, time

from pydantic import BaseModel, Field, model_validator


class OperationalAbsenceProjectManagerRead(BaseModel):
    id: int
    display_name: str
    short_code: str

    model_config = {"from_attributes": True}


class OperationalAbsenceSiteRead(BaseModel):
    id: int
    site_number: str | None = None
    name: str

    model_config = {"from_attributes": True}


class OperationalAbsenceCreate(BaseModel):
    project_manager_id: int = Field(gt=0)
    date: Date
    start_time: time | None = None
    end_time: time | None = None
    site_id: int | None = Field(default=None, gt=0)
    text: str | None = None

    @model_validator(mode="after")
    def validate_time_range(self) -> "OperationalAbsenceCreate":
        validate_operational_absence_times(self.start_time, self.end_time)
        return self


class OperationalAbsenceRead(BaseModel):
    id: int
    project_manager_id: int
    date: Date = Field(validation_alias="absence_date")
    start_time: time | None = None
    end_time: time | None = None
    site_id: int | None = None
    text: str | None = None
    created_by_user_id: int | None = None
    project_manager: OperationalAbsenceProjectManagerRead
    site: OperationalAbsenceSiteRead | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


def validate_operational_absence_times(
    start_time: time | None,
    end_time: time | None,
) -> None:
    if (start_time is None) != (end_time is None):
        raise ValueError("Von und Bis müssen gemeinsam angegeben werden.")
    if start_time is not None and end_time is not None and end_time <= start_time:
        raise ValueError("Bis muss nach Von liegen.")
