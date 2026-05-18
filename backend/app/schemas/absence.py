from datetime import date, datetime

from pydantic import BaseModel, model_validator

from app.models.enums import AbsenceStatus, AbsenceType


class AbsenceCreate(BaseModel):
    person_id: int
    absence_type: AbsenceType
    start_date: date
    end_date: date
    status: AbsenceStatus = AbsenceStatus.ACTIVE
    note: str | None = None

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date darf nicht vor start_date liegen.")
        return self


class AbsenceUpdate(BaseModel):
    person_id: int | None = None
    absence_type: AbsenceType | None = None
    start_date: date | None = None
    end_date: date | None = None
    status: AbsenceStatus | None = None
    note: str | None = None

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date darf nicht vor start_date liegen.")
        return self


class AbsenceRead(BaseModel):
    id: int
    person_id: int
    absence_type: AbsenceType
    start_date: date
    end_date: date
    status: AbsenceStatus
    note: str | None = None
    created_by_user_id: int | None = None
    updated_by_user_id: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
