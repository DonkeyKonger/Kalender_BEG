from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class CustomerContactBase(BaseModel):
    contact_type: str = Field(default="monteur", max_length=40)
    name: str = Field(min_length=1, max_length=200)
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


class CustomerBase(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    address_street: str | None = Field(default=None, max_length=200)
    address_house_number: str | None = Field(default=None, max_length=40)
    address_postal_code: str | None = Field(default=None, max_length=20)
    address_city: str | None = Field(default=None, max_length=120)
    address_country: str | None = Field(default="Deutschland", max_length=120)
    company_phone: str | None = Field(default=None, max_length=80)
    project_lead_name: str | None = Field(default=None, max_length=200)
    project_lead_phone: str | None = Field(default=None, max_length=80)
    project_lead_email: str | None = Field(default=None, max_length=255)
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
    company_phone: str | None = Field(default=None, max_length=80)
    project_lead_name: str | None = Field(default=None, max_length=200)
    project_lead_phone: str | None = Field(default=None, max_length=80)
    project_lead_email: str | None = Field(default=None, max_length=255)
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
    company_phone: str | None = None
    project_lead_name: str | None = None
    project_lead_phone: str | None = None
    project_lead_email: str | None = None
    is_active: bool
    contacts: list[CustomerContactRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomerRemoveResponse(BaseModel):
    action: Literal["deactivated"]
    customer: CustomerRead
