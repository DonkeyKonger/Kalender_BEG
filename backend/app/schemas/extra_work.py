from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ExtraWorkTicketCreate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    kind: str | None = Field(default=None, pattern="^(billing|approval)$")
    approval_ticket_id: int | None = None
    notes: str | None = Field(default=None, max_length=2000)


class ExtraWorkTicketStatusUpdate(BaseModel):
    status: str = Field(pattern="^(submitted)$")


class ExtraWorkTicketTitleUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)


class ExtraWorkSignaturePoint(BaseModel):
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)


class ExtraWorkCustomerSignatureCreate(BaseModel):
    customer_name: str = Field(..., min_length=1, max_length=160)
    customer_place: str | None = Field(default=None, max_length=160)
    signature_strokes: list[list[ExtraWorkSignaturePoint]] = Field(..., min_length=1)

    @field_validator("signature_strokes")
    @classmethod
    def validate_signature_strokes(
        cls, strokes: list[list[ExtraWorkSignaturePoint]]
    ) -> list[list[ExtraWorkSignaturePoint]]:
        if not any(len(stroke) >= 2 for stroke in strokes):
            raise ValueError("Unterschrift ist erforderlich.")
        return strokes


class ExtraWorkWorkerSignatureCreate(BaseModel):
    worker_name: str = Field(..., min_length=1, max_length=160)
    signature_strokes: list[list[ExtraWorkSignaturePoint]] = Field(..., min_length=1)

    @field_validator("signature_strokes")
    @classmethod
    def validate_signature_strokes(
        cls, strokes: list[list[ExtraWorkSignaturePoint]]
    ) -> list[list[ExtraWorkSignaturePoint]]:
        if not any(len(stroke) >= 2 for stroke in strokes):
            raise ValueError("Unterschrift ist erforderlich.")
        return strokes


class ExtraWorkWorkerHours(BaseModel):
    worker_name: str = Field(min_length=1, max_length=160)
    monday_hours: float = Field(default=0, ge=0, le=24)
    tuesday_hours: float = Field(default=0, ge=0, le=24)
    wednesday_hours: float = Field(default=0, ge=0, le=24)
    thursday_hours: float = Field(default=0, ge=0, le=24)
    friday_hours: float = Field(default=0, ge=0, le=24)
    saturday_hours: float = Field(default=0, ge=0, le=24)
    sunday_hours: float = Field(default=0, ge=0, le=24)


class ExtraWorkTicketEntryPayload(BaseModel):
    component: str = Field(min_length=1, max_length=160)
    floor: str = Field(min_length=1, max_length=120)
    room_number: str | None = Field(default=None, max_length=80)
    axis: str | None = Field(default=None, max_length=80)
    remarks: str | None = Field(default=None, max_length=4000)
    material_text: str | None = Field(default=None, max_length=4000)
    estimated_hours: float | None = Field(default=None, ge=0, le=10000)
    worker_rows: list[ExtraWorkWorkerHours] = Field(min_length=1, max_length=20)


class ExtraWorkTicketEntryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ticket_id: int
    site_id: int
    component: str
    floor: str
    room_number: str | None
    axis: str | None
    remarks: str | None
    material_text: str | None
    estimated_hours: float | None
    worker_rows: list[ExtraWorkWorkerHours]
    total_hours: float
    created_by_user_id: int | None
    created_at: datetime
    updated_at: datetime


class ExtraWorkTicketPhotoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    extra_work_ticket_id: int
    filename: str
    content_type: str
    file_size_bytes: int | None
    external_web_url: str | None
    uploaded_by_name: str | None = None
    taken_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ExtraWorkTicketRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    sequence_number: int
    display_number: str
    title: str | None
    kind: str
    approval_ticket_id: int | None
    status: str
    created_by_user_id: int | None
    submitted_by_user_id: int | None
    submitted_at: datetime | None
    notes: str | None
    customer_signature_type: str | None
    customer_signature_name: str | None
    customer_signature_place: str | None
    customer_signed_at: datetime | None
    worker_signature_name: str | None
    worker_signed_at: datetime | None
    entry_count: int
    total_hours: float
    estimated_hours: float | None
    created_at: datetime
    updated_at: datetime
