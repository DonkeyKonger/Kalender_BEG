from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import PersonType, SiteLocationStatus


class PersonBase(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=200)
    short_code: str = Field(min_length=1, max_length=30)
    person_type: PersonType = PersonType.INTERNAL
    is_active: bool = True
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


class PersonRead(PersonBase):
    id: int
    deleted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


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
