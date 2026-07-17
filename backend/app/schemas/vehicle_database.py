from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class VehicleEmployeeRead(BaseModel):
    id: int
    display_name: str
    short_code: str

    model_config = {"from_attributes": True}


class CtrackVehicleRead(BaseModel):
    id: int
    label: str
    vehicle_registration: str | None = None
    fleet_number: str | None = None


class VehicleBase(BaseModel):
    license_plate: str = Field(min_length=1, max_length=30)
    manufacturer: str = Field(min_length=1, max_length=120)
    assigned_person_id: int | None = None
    ctrack_vehicle_asset_id: int | None = None

    @field_validator("license_plate")
    @classmethod
    def normalize_license_plate(cls, value: str) -> str:
        normalized = " ".join(value.strip().upper().split())
        if not normalized:
            raise ValueError("Kennzeichen ist erforderlich.")
        return normalized

    @field_validator("manufacturer")
    @classmethod
    def normalize_manufacturer(cls, value: str) -> str:
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("Hersteller ist erforderlich.")
        return normalized


class VehicleCreate(VehicleBase):
    pass


class VehicleUpdate(BaseModel):
    license_plate: str | None = Field(default=None, min_length=1, max_length=30)
    manufacturer: str | None = Field(default=None, min_length=1, max_length=120)
    assigned_person_id: int | None = None
    ctrack_vehicle_asset_id: int | None = None

    @field_validator("license_plate")
    @classmethod
    def normalize_license_plate(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.strip().upper().split())
        if not normalized:
            raise ValueError("Kennzeichen ist erforderlich.")
        return normalized

    @field_validator("manufacturer")
    @classmethod
    def normalize_manufacturer(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("Hersteller ist erforderlich.")
        return normalized


class VehicleRead(VehicleBase):
    id: int
    assigned_person: VehicleEmployeeRead | None = None
    ctrack_vehicle: CtrackVehicleRead | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class VehicleEmployeeOptionRead(VehicleEmployeeRead):
    pass


class CtrackVehicleOptionRead(CtrackVehicleRead):
    linked_vehicle_id: int | None = None


class VehicleOptionsRead(BaseModel):
    employees: list[VehicleEmployeeOptionRead]
    ctrack_vehicles: list[CtrackVehicleOptionRead]


class VehicleListQuery(BaseModel):
    search: str | None = Field(default=None, max_length=200)
    sort_by: Literal["license_plate", "manufacturer", "employee", "ctrack"] = "license_plate"
    sort_direction: Literal["asc", "desc"] = "asc"
