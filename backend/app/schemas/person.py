from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.enums import PersonEmploymentStatus, PersonType, SiteLocationStatus, UserRole


class PersonBase(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    short_code: str = Field(min_length=1, max_length=30)
    person_type: PersonType = PersonType.INTERNAL
    is_active: bool = True
    employment_status: PersonEmploymentStatus = PersonEmploymentStatus.ACTIVE
    annual_vacation_days: int | None = Field(default=None, ge=0, le=365)
    weekly_hours: float | None = Field(default=None, ge=0, le=80)
    can_sign_measurements_immediately: bool = False
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=80)
    address_postal_code: str | None = Field(default=None, max_length=20)
    address_city: str | None = Field(default=None, max_length=120)
    address_street: str | None = Field(default=None, max_length=200)
    address_house_number: str | None = Field(default=None, max_length=40)
    address_extra: str | None = Field(default=None, max_length=200)
    address_formatted: str | None = Field(default=None, max_length=500)
    address_latitude: float | None = Field(default=None, ge=-90, le=90)
    address_longitude: float | None = Field(default=None, ge=-180, le=180)
    address_location_status: SiteLocationStatus = SiteLocationStatus.UNCHECKED
    notes: str | None = None

    @model_validator(mode="after")
    def sync_employment_status(self) -> "PersonBase":
        if "employment_status" in self.model_fields_set:
            self.is_active = self.employment_status == PersonEmploymentStatus.ACTIVE
        elif "is_active" in self.model_fields_set:
            self.employment_status = PersonEmploymentStatus.ACTIVE if self.is_active else PersonEmploymentStatus.DEPARTED
        return self


class PersonCreate(PersonBase):
    pass


class ExternalPersonCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)


class PersonUpdate(BaseModel):
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    short_code: str | None = Field(default=None, min_length=1, max_length=30)
    person_type: PersonType | None = None
    is_active: bool | None = None
    employment_status: PersonEmploymentStatus | None = None
    annual_vacation_days: int | None = Field(default=None, ge=0, le=365)
    weekly_hours: float | None = Field(default=None, ge=0, le=80)
    can_sign_measurements_immediately: bool | None = None
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=80)
    address_postal_code: str | None = Field(default=None, max_length=20)
    address_city: str | None = Field(default=None, max_length=120)
    address_street: str | None = Field(default=None, max_length=200)
    address_house_number: str | None = Field(default=None, max_length=40)
    address_extra: str | None = Field(default=None, max_length=200)
    address_formatted: str | None = Field(default=None, max_length=500)
    address_latitude: float | None = Field(default=None, ge=-90, le=90)
    address_longitude: float | None = Field(default=None, ge=-180, le=180)
    address_location_status: SiteLocationStatus | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def sync_employment_status(self) -> "PersonUpdate":
        if "employment_status" in self.model_fields_set and self.employment_status is not None:
            self.is_active = self.employment_status == PersonEmploymentStatus.ACTIVE
        elif "is_active" in self.model_fields_set and self.is_active is not None:
            self.employment_status = PersonEmploymentStatus.ACTIVE if self.is_active else PersonEmploymentStatus.DEPARTED
        return self


class PersonRead(PersonBase):
    id: int
    user_roles: list[UserRole] = Field(default_factory=list)
    deleted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PersonToolMaterialRead(BaseModel):
    beg_number: str | None = None
    manufacturer: str | None = None
    designation: str
    item_date: date | None = None


class PersonMapProjectManager(BaseModel):
    id: int
    display_name: str
    short_code: str

    model_config = {"from_attributes": True}


class PersonMapItem(BaseModel):
    id: int
    display_name: str
    short_name: str
    role: PersonType
    project_manager_assignment: PersonMapProjectManager | None = None
    address_city: str | None = None
    address_postal_code: str | None = None
    address_formatted: str | None = None
    address_latitude: float
    address_longitude: float
    address_location_status: SiteLocationStatus
    active: bool


class PersonMapResponse(BaseModel):
    people: list[PersonMapItem]
    missing_location: int


class PersonGeocodeSearchResult(BaseModel):
    label: str
    postal_code: str | None = None
    city: str | None = None
    street: str | None = None
    house_number: str | None = None
    latitude: float
    longitude: float
    confidence: float | None = None
    source: str | None = None


class PersonRemovePlan(BaseModel):
    action: Literal["delete", "deactivate"]


class PersonRemoveResponse(BaseModel):
    action: Literal["deleted", "deactivated"]
    person: PersonRead | None = None
