from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MeasurementBaseRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    name: str
    base_type: str | None
    status: str
    released_to_mobile: bool
    source_note: str | None
    import_label: str | None
    closed_at: datetime | None
    item_count: int = 0
    batch_count: int = 0
    created_at: datetime
    updated_at: datetime


class MeasurementBaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    status: str | None = Field(default=None, pattern="^(draft|active|closed|archived)$")
    released_to_mobile: bool | None = None
    source_note: str | None = Field(default=None, max_length=1000)
    import_label: str | None = Field(default=None, max_length=160)


class MeasurementItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    measurement_base_id: int
    source_file_name: str | None
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    source_section_key: str | None = None
    source_section_title: str | None = None
    position: str
    description: str
    list_quantity: Decimal | None
    unit: str | None
    minutes_per_unit: Decimal | None
    list_minutes_total: Decimal | None
    is_nep: bool
    is_free_position: bool = False
    is_hidden: bool = False
    sort_order: int
    measurement_base: MeasurementBaseRead | None = None
    created_at: datetime
    updated_at: datetime


class MobileMeasurementFreeItemCreate(BaseModel):
    position: str | None = Field(default=None, max_length=80)
    description: str = Field(..., min_length=1, max_length=2000)
    unit: str = Field(..., min_length=1, max_length=40)
    quantity: Decimal = Field(default=Decimal("0"), ge=0)
    area_or_comment: str | None = Field(default=None, max_length=1000)

    @field_validator("position", "description", "unit", "area_or_comment", mode="before")
    @classmethod
    def strip_text_fields(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


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


class MeasurementAreaRowCreate(BaseModel):
    area_or_comment: str = Field(..., min_length=1, max_length=1000)

    @field_validator("area_or_comment", mode="before")
    @classmethod
    def strip_area_or_comment(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


class MeasurementAreaRowRead(BaseModel):
    id: int
    measurement_batch_id: int
    site_id: int
    area_or_comment: str
    sort_order: int
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


class MobileMeasurementBatchPhotoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    site_id: int
    measurement_batch_id: int
    filename: str
    content_type: str
    file_size_bytes: int | None
    external_web_url: str | None
    uploaded_by_name: str | None = None
    taken_at: datetime | None
    created_at: datetime
    updated_at: datetime


class MobileMeasurementBatchAvailableActionsRead(BaseModel):
    can_customer_sign: bool


class MobileMeasurementBatchBlockReasonsRead(BaseModel):
    customer_sign: str | None = None


class MobileMeasurementBatchRead(BaseModel):
    id: int
    site_id: int
    measurement_base_id: int
    measurement_base_name: str | None
    offer_id: int
    offer_name: str | None
    is_current_offer: bool
    number: int
    title: str
    status: str
    created_by_user_id: int | None
    created_by_name: str | None = None
    submitted_by_user_id: int | None
    submitted_by_name: str | None
    submitted_at: datetime | None
    customer_signed_at: datetime | None
    customer_signature_name: str | None
    customer_signature_place: str | None
    customer_email_sent_at: datetime | None = None
    customer_email_signature_present: bool | None = None
    worker_signed_at: datetime | None
    worker_signature_name: str | None
    is_locked_for_worker: bool = False
    created_at: datetime
    updated_at: datetime
    position_count: int
    entry_count: int
    reported_minutes: Decimal | None
    reported_hours: Decimal | None
    photo_count: int = 0
    available_actions: MobileMeasurementBatchAvailableActionsRead
    block_reasons: MobileMeasurementBatchBlockReasonsRead
    area_rows: list[MeasurementAreaRowRead] = Field(default_factory=list)


class MeasurementTimesheetKpiRead(BaseModel):
    position_count: int
    planned_minutes: Decimal
    measured_minutes: Decimal
    open_minutes: Decimal | None
    progress_percent: float | None
    captured_count: int
    not_captured_count: int
    has_planned_basis: bool


class MeasurementTimesheetRowRead(BaseModel):
    position_id: int
    position_number: str
    description: str
    unit: str | None
    target_quantity: Decimal | None
    measured_quantity: Decimal
    remaining_quantity: Decimal | None
    minutes_per_unit: Decimal | None
    planned_minutes: Decimal
    measured_minutes: Decimal
    progress_percent: float | None
    is_captured: bool
    search_text: str


class MeasurementTimesheetRead(BaseModel):
    site_id: int
    measurement_base_id: int | None
    active_batch_ids: list[int]
    active_measurement_label: str | None
    last_import_label: str | None
    last_import_at: datetime | None
    kpi: MeasurementTimesheetKpiRead
    rows: list[MeasurementTimesheetRowRead]


class MeasurementTimeAnalysisExtraWorkTicketRead(BaseModel):
    id: int
    display_number: str
    title: str | None
    status: str
    relevant_at: datetime | None
    planned_minutes: Decimal


class MeasurementTimeAnalysisRowRead(BaseModel):
    measurement_batch_id: int
    measurement_number: int
    measurement_title: str
    measurement_status: str
    analysis_at: datetime | None
    period_start: datetime | None
    period_end: datetime | None
    measurement_minutes: Decimal
    extra_work_minutes: Decimal
    planned_minutes: Decimal
    actual_minutes: Decimal
    deviation_minutes: Decimal
    consumption_percent: float | None
    extra_work_tickets: list[MeasurementTimeAnalysisExtraWorkTicketRead]


class MeasurementTimeAnalysisTotalsRead(BaseModel):
    planned_minutes: Decimal
    actual_minutes: Decimal
    deviation_minutes: Decimal
    consumption_percent: float | None


class MeasurementTimeAnalysisRead(BaseModel):
    site_id: int
    totals: MeasurementTimeAnalysisTotalsRead
    rows: list[MeasurementTimeAnalysisRowRead]


class CustomerSignaturePoint(BaseModel):
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)


class CustomerSignatureCreate(BaseModel):
    customer_name: str = Field(..., min_length=1, max_length=160)
    signature_strokes: list[list[CustomerSignaturePoint]] = Field(..., min_length=1)

    @field_validator("signature_strokes")
    @classmethod
    def validate_signature_strokes(
        cls, strokes: list[list[CustomerSignaturePoint]]
    ) -> list[list[CustomerSignaturePoint]]:
        if not any(len(stroke) >= 2 for stroke in strokes):
            raise ValueError("Unterschrift ist erforderlich.")
        return strokes


class WorkerSignatureCreate(BaseModel):
    worker_name: str = Field(..., min_length=1, max_length=160)
    signature_strokes: list[list[CustomerSignaturePoint]] = Field(..., min_length=1)

    @field_validator("signature_strokes")
    @classmethod
    def validate_signature_strokes(
        cls, strokes: list[list[CustomerSignaturePoint]]
    ) -> list[list[CustomerSignaturePoint]]:
        if not any(len(stroke) >= 2 for stroke in strokes):
            raise ValueError("Unterschrift ist erforderlich.")
        return strokes


class MeasurementDashboardSubmissionRead(BaseModel):
    message_key: str
    batch_id: int | None
    extra_work_ticket_id: int | None = None
    site_id: int
    site_name: str
    site_number: str | None
    title: str
    status: str
    message_type: str
    event_at: datetime | None
    submitted_by_name: str | None
    submitted_at: datetime | None
    customer_signature_name: str | None = None
    customer_signed_at: datetime | None = None
    entry_count: int
    position_count: int


class DashboardMessagesSummaryRead(BaseModel):
    open_count: int
    latest_messages: list[MeasurementDashboardSubmissionRead]


class MeasurementImportResponse(BaseModel):
    imported_count: int
    measurement_base: MeasurementBaseRead
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    timesheet_document_saved: bool = False
    timesheet_document_name: str | None = None
    timesheet_document_error: str | None = None
    items: list[MeasurementItemRead]
