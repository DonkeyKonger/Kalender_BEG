from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict


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


class MeasurementImportResponse(BaseModel):
    imported_count: int
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    items: list[MeasurementItemRead]
