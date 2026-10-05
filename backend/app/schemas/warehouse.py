from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Direction = Literal["issue", "return"]
ReviewStatus = Literal["reviewed", "unreviewed"]
ReturnReason = Literal["defective", "lost", "warehouse"]


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
    return_reasons: dict[int, ReturnReason] = Field(default_factory=dict)

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

    @model_validator(mode="after")
    def valid_return_reasons(self):
        if self.direction != "return":
            if self.return_reasons:
                raise ValueError("Rückgabegründe sind nur bei Rückgaben zulässig.")
            return self
        if self.return_reasons and set(self.return_reasons) != set(self.tool_ids):
            raise ValueError("Für jedes ausgewählte Werkzeug muss genau ein Rückgabegrund angegeben werden.")
        return self


class WarehouseReceiptItemRead(WarehouseToolRead):
    return_reason: ReturnReason | None = None


class WarehouseReceiptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    direction: Direction
    employee_name: str
    items: list[WarehouseReceiptItemRead]
    created_at: datetime


class WarehouseHistoryQuery(BaseModel):
    search: str = Field(default="", max_length=160)
    direction: Direction | None = None
    review_status: ReviewStatus | None = None
    date_from: date | None = Field(default=None, ge=date(1900, 1, 1), le=date(9998, 12, 31))
    date_to: date | None = Field(default=None, ge=date(1900, 1, 1), le=date(9998, 12, 31))
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def ordered_dates(self):
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("Das Enddatum darf nicht vor dem Startdatum liegen.")
        return self


class WarehouseHistoryRead(WarehouseReceiptRead):
    actor_name: str
    review_status: ReviewStatus
    reviewed_at: datetime | None
    reviewed_by_name: str | None
    review_version: int


class WarehouseHistoryPage(BaseModel):
    items: list[WarehouseHistoryRead]
    total: int
    page: int
    page_size: int
    can_review: bool


class WarehouseHistoryDetail(WarehouseHistoryRead):
    signature_strokes: list[list[SignaturePoint]]


class WarehouseReviewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reviewed: bool = Field(strict=True)
    expected_version: int = Field(ge=0)
