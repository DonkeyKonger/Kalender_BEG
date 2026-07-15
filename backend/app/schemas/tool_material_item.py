from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models.enums import PersonType, ToolIssueReason, ToolMaterialCategory, ToolMaterialStatus


class ToolIssueSystemNoteRead(BaseModel):
    id: int
    reason: ToolIssueReason
    reporter_last_name_snapshot: str
    created_at: datetime

    model_config = {"from_attributes": True}


class ToolMaterialEmployeeRead(BaseModel):
    id: int
    display_name: str
    short_code: str
    person_type: PersonType
    is_active: bool

    model_config = {"from_attributes": True}


class ToolMaterialItemBase(BaseModel):
    beg_number: str | None = Field(default=None, max_length=120)
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
    category: ToolMaterialCategory = ToolMaterialCategory.OTHER
    status: ToolMaterialStatus = ToolMaterialStatus.WAREHOUSE


class ToolMaterialItemCreate(ToolMaterialItemBase):
    beg_number: str = Field(min_length=1, max_length=120)


class ToolMaterialItemUpdate(BaseModel):
    beg_number: str | None = Field(default=None, max_length=120)
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
    category: ToolMaterialCategory = ToolMaterialCategory.OTHER
    status: ToolMaterialStatus = ToolMaterialStatus.WAREHOUSE


class ToolMaterialItemRead(ToolMaterialItemBase):
    id: int
    employee: ToolMaterialEmployeeRead | None = None
    created_at: datetime
    updated_at: datetime
    open_issue_reports: list[ToolIssueSystemNoteRead] = Field(default_factory=list)

    model_config = {"from_attributes": True}


ToolMaterialSortField = Literal[
    "beg_number",
    "manufacturer",
    "designation",
    "item_type",
    "device_number",
    "serial_number",
    "employee",
    "item_date",
    "delivery_note",
    "remarks",
    "supplier",
    "invoice_number",
    "stock",
    "status",
]


class ToolMaterialListQuery(BaseModel):
    tool_id: int | None = Field(default=None, ge=1)
    search: str | None = Field(default=None, max_length=200)
    filter_beg_number: str | None = Field(default=None, max_length=200)
    filter_manufacturer: str | None = Field(default=None, max_length=200)
    filter_designation: str | None = Field(default=None, max_length=200)
    filter_item_type: str | None = Field(default=None, max_length=200)
    filter_device_number: str | None = Field(default=None, max_length=200)
    filter_serial_number: str | None = Field(default=None, max_length=200)
    filter_employee: str | None = Field(default=None, max_length=200)
    filter_delivery_note: str | None = Field(default=None, max_length=200)
    filter_remarks: str | None = Field(default=None, max_length=200)
    filter_supplier: str | None = Field(default=None, max_length=200)
    filter_invoice_number: str | None = Field(default=None, max_length=200)
    values_beg_number: list[str] = Field(default_factory=list)
    values_manufacturer: list[str] = Field(default_factory=list)
    values_designation: list[str] = Field(default_factory=list)
    values_item_type: list[str] = Field(default_factory=list)
    values_device_number: list[str] = Field(default_factory=list)
    values_serial_number: list[str] = Field(default_factory=list)
    values_employee: list[str] = Field(default_factory=list)
    values_item_date: list[str] = Field(default_factory=list)
    values_delivery_note: list[str] = Field(default_factory=list)
    values_remarks: list[str] = Field(default_factory=list)
    values_supplier: list[str] = Field(default_factory=list)
    values_invoice_number: list[str] = Field(default_factory=list)
    values_stock: list[str] = Field(default_factory=list)
    values_status: list[ToolMaterialStatus] = Field(default_factory=list)
    date_from: date | None = None
    date_to: date | None = None
    stock_min: int | None = Field(default=None, ge=0)
    stock_max: int | None = Field(default=None, ge=0)
    sort_by: ToolMaterialSortField | None = None
    sort_direction: Literal["asc", "desc"] = "asc"


class ToolMaterialFilterOption(BaseModel):
    value: str
    label: str


class ToolMaterialFilterOptionsRead(BaseModel):
    columns: dict[str, list[ToolMaterialFilterOption]]


class ToolResponsibleUserRead(BaseModel):
    id: int
    display_name: str
    is_active: bool
    is_valid: bool
    invalid_reason: str | None = None


class ToolMaterialResponsibilityRead(BaseModel):
    tool_responsible_user_id: int | None
    responsible_user: ToolResponsibleUserRead | None


class ToolMaterialResponsibilityUpdate(BaseModel):
    tool_responsible_user_id: int | None
