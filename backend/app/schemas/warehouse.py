from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Direction = Literal["issue", "return"]


class WarehousePersonRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    display_name: str
    short_code: str


class WarehouseToolRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    beg_number: str | None
    designation: str
    manufacturer: str | None
    item_type: str | None
    device_number: str | None
    serial_number: str | None
    category: str


class WarehouseToolPage(BaseModel):
    items: list[WarehouseToolRead]
    total: int


class SignaturePoint(BaseModel):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class WarehouseMovementCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    direction: Direction
    employee_id: int = Field(gt=0)
    tool_ids: list[Annotated[int, Field(gt=0)]] = Field(min_length=1, max_length=100)
    signature_strokes: list[Annotated[list[SignaturePoint], Field(min_length=2, max_length=4000)]] = Field(
        min_length=1, max_length=100,
    )

    @field_validator("tool_ids")
    @classmethod
    def unique_tools(cls, ids: list[int]) -> list[int]:
        if len(set(ids)) != len(ids):
            raise ValueError("Werkzeuge dürfen nur einmal ausgewählt werden.")
        return sorted(ids)

    @field_validator("signature_strokes")
    @classmethod
    def real_signature(cls, strokes: list[list[SignaturePoint]]) -> list[list[SignaturePoint]]:
        if sum(map(len, strokes)) > 12000:
            raise ValueError("Unterschrift ist zu umfangreich. Bitte erneut unterschreiben.")
        if not any(any(point != stroke[0] for point in stroke[1:]) for stroke in strokes):
            raise ValueError("Bitte eine Unterschrift zeichnen.")
        return strokes


class WarehouseReceiptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    direction: Direction
    employee_name: str
    items: list[WarehouseToolRead]
    created_at: datetime
