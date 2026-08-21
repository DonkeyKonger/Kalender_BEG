import datetime as dt
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.extra_work_dates import validate_iso_week


class ExtraWorkTicketCreate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    kind: str | None = Field(default=None, pattern="^(billing|approval)$")
    approval_ticket_id: int | None = None
    notes: str | None = Field(default=None, max_length=2000)


class ExtraWorkTicketStatusUpdate(BaseModel):
    status: str = Field(pattern="^(submitted)$")


class ExtraWorkTicketManualStatusUpdate(BaseModel):
    status: str = Field(min_length=1, max_length=32)


class ExtraWorkTicketTitleUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)


class ExtraWorkTicketDetailsUpdate(BaseModel):
    manual_order_date: date | None = None
    manual_execution_week: int | None = Field(default=None, ge=1, le=53)
    manual_execution_week_year: int | None = Field(default=None, ge=1, le=9999)

    @model_validator(mode="after")
    def validate_manual_execution_week(self) -> "ExtraWorkTicketDetailsUpdate":
        if (self.manual_execution_week is None) != (self.manual_execution_week_year is None):
            raise ValueError("Kalenderwoche und ISO-Jahr müssen gemeinsam angegeben werden.")
        if self.manual_execution_week is not None and self.manual_execution_week_year is not None:
            validate_iso_week(self.manual_execution_week_year, self.manual_execution_week)
        return self


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
    person_id: int | None = Field(default=None, gt=0)
    worker_name: str = Field(default="", max_length=160)
    monday_hours: float | None = Field(default=None, ge=0, le=24)
    tuesday_hours: float | None = Field(default=None, ge=0, le=24)
    wednesday_hours: float | None = Field(default=None, ge=0, le=24)
    thursday_hours: float | None = Field(default=None, ge=0, le=24)
    friday_hours: float | None = Field(default=None, ge=0, le=24)
    saturday_hours: float | None = Field(default=None, ge=0, le=24)
    sunday_hours: float | None = Field(default=None, ge=0, le=24)
    monday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    tuesday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    wednesday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    thursday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    friday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    saturday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    sunday_surcharge_25_hours: float | None = Field(default=None, ge=0, le=24)
    monday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    tuesday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    wednesday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    thursday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    friday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    saturday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)
    sunday_surcharge_50_hours: float | None = Field(default=None, ge=0, le=24)

    @model_validator(mode="after")
    def validate_worker_hours(self) -> "ExtraWorkWorkerHours":
        for weekday in (
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ):
            values = (
                getattr(self, f"{weekday}_hours"),
                getattr(self, f"{weekday}_surcharge_25_hours"),
                getattr(self, f"{weekday}_surcharge_50_hours"),
            )
            if sum(value or 0 for value in values) > 24:
                raise ValueError("Pro Monteur und Wochentag sind maximal 24 Stunden erlaubt.")
        hour_values = [
            value
            for field_name, value in self.__dict__.items()
            if field_name.endswith("_hours")
        ]
        if (self.person_id is not None or any(value is not None for value in hour_values)) and not self.worker_name.strip():
            raise ValueError("Für erfasste Stunden ist ein Monteurname erforderlich.")
        return self


class ExtraWorkTicketEntryPayload(BaseModel):
    component: str = Field(min_length=1, max_length=160)
    floor: str = Field(min_length=1, max_length=120)
    room_number: str | None = Field(default=None, max_length=80)
    axis: str | None = Field(default=None, max_length=80)
    remarks: str | None = Field(default=None, max_length=4000)
    material_text: str | None = Field(default=None, max_length=4000)
    estimated_hours: float | None = Field(default=None, ge=0, le=10000)
    worker_rows: list[ExtraWorkWorkerHours] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_mobile_workers(self) -> "ExtraWorkTicketEntryPayload":
        if any(not row.worker_name.strip() for row in self.worker_rows):
            raise ValueError("Für jeden Monteur ist ein Name erforderlich.")
        return self


class ExtraWorkTicketDocumentEntryUpdate(BaseModel):
    component: str = Field(default="", max_length=160)
    floor: str = Field(default="", max_length=120)
    room_number: str | None = Field(default=None, max_length=80)
    axis: str | None = Field(default=None, max_length=80)
    remarks: str | None = Field(default=None, max_length=4000)
    material_text: str | None = Field(default=None, max_length=4000)
    estimated_hours: float | None = Field(default=None, ge=0, le=10000)
    worker_rows: list[ExtraWorkWorkerHours] = Field(default_factory=list, max_length=20)


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
    caption: str | None = None
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
    created_by_name: str | None = None
    submitted_by_user_id: int | None
    submitted_at: datetime | None
    notes: str | None
    ordered_by_name: str | None = None
    ordered_by_company: str | None = None
    billing_type: str | None = None
    estimated_order_value: float | None = None
    material_required: bool | None = None
    material_separate_attachment: bool | None = None
    executed_by_lead_monteur: bool | None = None
    executed_by_monteur: bool | None = None
    executed_by_helper: bool | None = None
    executor_other_name: str | None = None
    work_description: str | None = None
    manual_order_date: date | None
    manual_execution_week: int | None
    manual_execution_week_year: int | None
    manual_execution_start: date | None = None
    manual_execution_end: date | None = None
    customer_signature_type: str | None
    customer_signature_name: str | None
    customer_signature_place: str | None
    customer_signed_at: datetime | None
    customer_email_sent_at: datetime | None = None
    customer_email_signature_present: bool | None = None
    worker_signature_name: str | None
    worker_signature_place: str | None = None
    worker_signature_date: date | None = None
    worker_signed_at: datetime | None
    deleted_at: datetime | None = None
    deleted_by_user_id: int | None = None
    deleted_by_name: str | None = None
    entry_count: int
    photo_count: int
    total_hours: float
    estimated_hours: float | None
    created_at: datetime
    updated_at: datetime


class ExtraWorkTicketDocumentDatesRead(BaseModel):
    order_date: date
    approval_date: date
    approval_place: str | None
    execution_start: date
    execution_end: date


class ExtraWorkTicketDocumentWorkerSignatureRead(BaseModel):
    name: str | None
    place: str | None = None
    date: dt.date | None = None
    signed_at: datetime | None
    strokes: list[list[ExtraWorkSignaturePoint]] | None


class ExtraWorkTicketDocumentCustomerSignatureRead(BaseModel):
    type: str | None
    name: str | None
    place: str | None
    signed_at: datetime | None
    strokes: list[list[ExtraWorkSignaturePoint]] | None


class ExtraWorkTicketDocumentRead(BaseModel):
    ticket: ExtraWorkTicketRead
    entry: ExtraWorkTicketEntryRead | None
    resolved_dates: ExtraWorkTicketDocumentDatesRead
    worker_signature: ExtraWorkTicketDocumentWorkerSignatureRead
    customer_signature: ExtraWorkTicketDocumentCustomerSignatureRead


class ExtraWorkTicketDocumentUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    ordered_by_name: str | None = Field(default=None, max_length=160)
    ordered_by_company: str | None = Field(default=None, max_length=200)
    billing_type: str | None = Field(
        default=None,
        pattern="^(flat_rate|hourly|unit_price)$",
    )
    estimated_order_value: float | None = Field(default=None, ge=0, le=9999999999.99)
    material_required: bool | None = None
    material_separate_attachment: bool | None = None
    executed_by_lead_monteur: bool | None = None
    executed_by_monteur: bool | None = None
    executed_by_helper: bool | None = None
    executor_other_name: str | None = Field(default=None, max_length=160)
    work_description: str | None = Field(default=None, max_length=12000)
    manual_order_date: date | None = None
    manual_execution_week: int | None = Field(default=None, ge=1, le=53)
    manual_execution_week_year: int | None = Field(default=None, ge=1, le=9999)
    manual_execution_start: date | None = None
    manual_execution_end: date | None = None
    worker_signature_name: str | None = Field(default=None, max_length=160)
    worker_signature_place: str | None = Field(default=None, max_length=160)
    worker_signature_date: date | None = None
    worker_signature_strokes: list[list[ExtraWorkSignaturePoint]] | None = None
    entry: ExtraWorkTicketDocumentEntryUpdate | None = None

    @model_validator(mode="after")
    def validate_document_dates(self) -> "ExtraWorkTicketDocumentUpdate":
        if (self.manual_execution_week is None) != (self.manual_execution_week_year is None):
            raise ValueError("Kalenderwoche und ISO-Jahr müssen gemeinsam angegeben werden.")
        if self.manual_execution_week is not None and self.manual_execution_week_year is not None:
            validate_iso_week(self.manual_execution_week_year, self.manual_execution_week)
        if (self.manual_execution_start is None) != (self.manual_execution_end is None):
            raise ValueError("Ausführungsbeginn und Ausführungsende müssen gemeinsam angegeben werden.")
        if (
            self.manual_execution_start is not None
            and self.manual_execution_end is not None
            and self.manual_execution_start > self.manual_execution_end
        ):
            raise ValueError("Ausführungsbeginn darf nicht nach dem Ausführungsende liegen.")
        if self.worker_signature_strokes is not None:
            if not any(len(stroke) >= 2 for stroke in self.worker_signature_strokes):
                raise ValueError("Monteursunterschrift ist erforderlich.")
            if not self.worker_signature_name or not self.worker_signature_name.strip():
                raise ValueError("Monteurname ist für die Unterschrift erforderlich.")
        return self


class ExtraWorkTicketEmailSendRead(BaseModel):
    sent_at: datetime
    recipients: list[str]
    filename: str
