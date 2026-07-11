from datetime import date, datetime

from pydantic import BaseModel, Field


class ToolMaterialEmployeeRead(BaseModel):
    id: int
    display_name: str
    short_code: str

    model_config = {"from_attributes": True}


class ToolMaterialItemBase(BaseModel):
    manufacturer: str | None = Field(default=None, max_length=200)
    designation: str = Field(min_length=1, max_length=240)
    item_type: str | None = Field(default=None, max_length=160)
    device_number: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=160)
    employee_id: int | None = None
    item_date: date | None = None
    delivery_note: str | None = Field(default=None, max_length=160)
    remarks: str | None = Field(default=None, max_length=2000)
    supplier: str | None = Field(default=None, max_length=200)
    invoice_number: str | None = Field(default=None, max_length=160)
    stock: int | None = Field(default=None, ge=0)


class ToolMaterialItemCreate(ToolMaterialItemBase):
    pass


class ToolMaterialItemUpdate(BaseModel):
    manufacturer: str | None = Field(default=None, max_length=200)
    designation: str | None = Field(default=None, min_length=1, max_length=240)
    item_type: str | None = Field(default=None, max_length=160)
    device_number: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=160)
    employee_id: int | None = None
    item_date: date | None = None
    delivery_note: str | None = Field(default=None, max_length=160)
    remarks: str | None = Field(default=None, max_length=2000)
    supplier: str | None = Field(default=None, max_length=200)
    invoice_number: str | None = Field(default=None, max_length=160)
    stock: int | None = Field(default=None, ge=0)


class ToolMaterialItemRead(ToolMaterialItemBase):
    id: int
    employee: ToolMaterialEmployeeRead | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
