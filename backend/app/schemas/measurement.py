from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class MeasurementItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    source_file_name: str | None
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    position: str
    description: str
    list_quantity: Decimal | None
    unit: str | None
    minutes_per_unit: Decimal | None
    list_minutes_total: Decimal | None
    is_nep: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime


class MeasurementEntryCreate(BaseModel):
    area_or_comment: str = Field(..., min_length=1, max_length=1000)
    quantity: Decimal = Field(..., gt=0)


class MeasurementEntryRead(BaseModel):
    id: int
    measurement_batch_id: int
    measurement_item_id: int
    site_id: int
    quantity: Decimal
    area_or_comment: str
    status: str
    created_by_user_id: int | None
    created_by_name: str | None
    created_at: datetime
    updated_at: datetime


class MobileMeasurementItemRead(MeasurementItemRead):
    entries: list[MeasurementEntryRead]
    reported_quantity: Decimal
    reported_minutes: Decimal | None
    reported_hours: Decimal | None
    mobile_status: str


class MobileMeasurementBatchRead(BaseModel):
    id: int
    site_id: int
    number: int
    title: str
    status: str
    created_by_user_id: int | None
    submitted_by_user_id: int | None
    submitted_by_name: str | None
    submitted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    position_count: int
    entry_count: int
    reported_minutes: Decimal | None
    reported_hours: Decimal | None


class MeasurementImportResponse(BaseModel):
    imported_count: int
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    items: list[MeasurementItemRead]
