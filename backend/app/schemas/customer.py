from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import SiteLocationStatus


class CustomerContactBase(BaseModel):
    contact_type: str | None = Field(default=None, max_length=40)
    name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=80)
    email: str | None = Field(default=None, max_length=255)


class CustomerContactCreate(CustomerContactBase):
    pass


class CustomerContactRead(CustomerContactBase):
    id: int
    customer_id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomerEmailAddressRead(BaseModel):
    email: str
    label: str | None = None
    source: str | None = None
    created_at: datetime | None = None


class CustomerBase(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    address_street: str | None = Field(default=None, max_length=200)
    address_house_number: str | None = Field(default=None, max_length=40)
    address_postal_code: str | None = Field(default=None, max_length=20)
    address_city: str | None = Field(default=None, max_length=120)
    address_country: str | None = Field(default="Deutschland", max_length=120)
    address_extra: str | None = Field(default=None, max_length=200)
    address_formatted: str | None = Field(default=None, max_length=500)
    address_latitude: float | None = Field(default=None, ge=-90, le=90)
    address_longitude: float | None = Field(default=None, ge=-180, le=180)
    address_location_status: SiteLocationStatus = SiteLocationStatus.UNCHECKED
    company_phone: str | None = Field(default=None, max_length=80)
    project_lead_name: str | None = Field(default=None, max_length=200)
    project_lead_phone: str | None = Field(default=None, max_length=80)
    project_lead_email: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    is_active: bool = True
    contacts: list[CustomerContactCreate] = Field(default_factory=list)


class CustomerCreate(CustomerBase):
    pass


class CustomerUpdate(BaseModel):
    company_name: str | None = Field(default=None, min_length=1, max_length=200)
    address_street: str | None = Field(default=None, max_length=200)
    address_house_number: str | None = Field(default=None, max_length=40)
    address_postal_code: str | None = Field(default=None, max_length=20)
    address_city: str | None = Field(default=None, max_length=120)
    address_country: str | None = Field(default=None, max_length=120)
    address_extra: str | None = Field(default=None, max_length=200)
    address_formatted: str | None = Field(default=None, max_length=500)
    address_latitude: float | None = Field(default=None, ge=-90, le=90)
    address_longitude: float | None = Field(default=None, ge=-180, le=180)
    address_location_status: SiteLocationStatus | None = None
    company_phone: str | None = Field(default=None, max_length=80)
    project_lead_name: str | None = Field(default=None, max_length=200)
    project_lead_phone: str | None = Field(default=None, max_length=80)
    project_lead_email: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    is_active: bool | None = None
    contacts: list[CustomerContactCreate] | None = None


class CustomerRead(BaseModel):
    id: int
    company_name: str
    address_street: str | None = None
    address_house_number: str | None = None
    address_postal_code: str | None = None
    address_city: str | None = None
    address_country: str | None = None
    address_extra: str | None = None
    address_formatted: str | None = None
    address_latitude: float | None = None
    address_longitude: float | None = None
    address_location_status: SiteLocationStatus = SiteLocationStatus.UNCHECKED
    company_phone: str | None = None
    project_lead_name: str | None = None
    project_lead_phone: str | None = None
    project_lead_email: str | None = None
    notes: str | None = None
    is_active: bool
    contacts: list[CustomerContactRead] = Field(default_factory=list)
    email_addresses: list[CustomerEmailAddressRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomerRemoveResponse(BaseModel):
    action: Literal["deleted"]
    customer: CustomerRead
