from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import SiteLocationStatus, SiteStatus


class SitePersonRead(BaseModel):
    id: int
    display_name: str
    short_code: str
    email: str | None = None
    phone: str | None = None

    model_config = {"from_attributes": True}


class SiteBase(BaseModel):
    site_number: str | None = Field(default=None, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    postal_code: str | None = Field(default=None, max_length=20)
    city: str | None = Field(default=None, max_length=120)
    street: str | None = Field(default=None, max_length=200)
    house_number: str | None = Field(default=None, max_length=40)
    address_extra: str | None = Field(default=None, max_length=200)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    geofence_radius_m: int = Field(default=5000, ge=1, le=100000)
    location_status: SiteLocationStatus = SiteLocationStatus.UNCHECKED
    customer: str | None = Field(default=None, max_length=200)
    project_manager_person_id: int | None = None
    status: SiteStatus = SiteStatus.ACTIVE
    info: str | None = None
    color: str | None = Field(default=None, max_length=30)


class SiteCreate(SiteBase):
    pass


class SiteUpdate(BaseModel):
    site_number: str | None = Field(default=None, max_length=80)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    postal_code: str | None = Field(default=None, max_length=20)
    city: str | None = Field(default=None, max_length=120)
    street: str | None = Field(default=None, max_length=200)
    house_number: str | None = Field(default=None, max_length=40)
    address_extra: str | None = Field(default=None, max_length=200)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    geofence_radius_m: int | None = Field(default=None, ge=1, le=100000)
    location_status: SiteLocationStatus | None = None
    customer: str | None = Field(default=None, max_length=200)
    project_manager_person_id: int | None = None
    status: SiteStatus | None = None
    info: str | None = None
    color: str | None = Field(default=None, max_length=30)


class SiteRead(SiteBase):
    id: int
    project_manager: SitePersonRead | None = None
    closed_at: datetime | None = None
    closed_by_user_id: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SiteMapItem(BaseModel):
    id: int
    name: str
    number: str | None = None
    city: str | None = None
    postal_code: str | None = None
    street: str | None = None
    house_number: str | None = None
    project_manager: SitePersonRead | None = None
    status: SiteStatus
    color: str | None = None
    latitude: float
    longitude: float
    geofence_radius_m: int
    location_status: SiteLocationStatus


class SiteMapResponse(BaseModel):
    sites: list[SiteMapItem]
    missing_location: int


class SiteGeocodeSearchResult(BaseModel):
    label: str
    postal_code: str | None = None
    city: str | None = None
    street: str | None = None
    house_number: str | None = None
    latitude: float
    longitude: float
    confidence: float | None = None
    source: str | None = None


class SiteRemovePlan(BaseModel):
    action: Literal["delete"]


class SiteRemoveResponse(BaseModel):
    action: Literal["deleted"]
    site: SiteRead | None = None
