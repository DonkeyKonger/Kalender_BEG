from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from io import BytesIO
import logging
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from fastapi import HTTPException, status
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase.pdfmetrics import stringWidth
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.project_folder import ProjectFolder
from app.models.user import User
from app.services.document_pdf_cache import DocumentPdfCache, build_pdf_version_hash
from app.services.extra_work_document_context import (
    get_extra_work_assignment_context,
    resolve_extra_work_approval_place,
    resolve_extra_work_ticket_dates,
)
from app.services.photo_appendix_pdf_service import (
    PhotoAppendixContext,
    PhotoAppendixPdfService,
    PhotoAppendixPhoto,
)
from app.services.photo_download_service import PhotoDownloadRequest, download_photo_files
from app.services.project_storage_service import ProjectStorageService

PAGE_WIDTH = 595.28
PAGE_HEIGHT = 841.89
EXTRA_WORK_PHOTO_FOLDER_KEY = "fotos"
EXTRA_WORK_PDF_CACHE_VERSION = "extra-work-pdf-layout-v12-compact-material"
LOGGER = logging.getLogger(__name__)
BEG_PDF_RED = (0.78, 0.05, 0.05)
TEMPLATE_PATH = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "extra_work"
    / "Zusatzauftrag_Vorlage_BEG_Master.pdf"
)
WEEKDAY_KEYS = (
    "monday_hours",
    "tuesday_hours",
    "wednesday_hours",
    "thursday_hours",
    "friday_hours",
    "saturday_hours",
    "sunday_hours",
)
SURCHARGE_25_KEYS = tuple(key.replace("_hours", "_surcharge_25_hours") for key in WEEKDAY_KEYS)
SURCHARGE_50_KEYS = tuple(key.replace("_hours", "_surcharge_50_hours") for key in WEEKDAY_KEYS)
WORKER_HOUR_CATEGORY_KEYS = (WEEKDAY_KEYS, SURCHARGE_25_KEYS, SURCHARGE_50_KEYS)


@dataclass(frozen=True)
class FieldRect:
    x: float
    y: float
    width: float
    height: float


FIELD_RECTS = {
    "Kunde": FieldRect(103.20, 119.20, 204.72, 14.17),
    "Projekt": FieldRect(363.85, 119.20, 186.84, 14.17),
    "Herrn": FieldRect(84.19, 157.23, 351.61, 14.17),
    "Datum": FieldRect(479.58, 157.20, 71.16, 14.17),
    "Firma": FieldRect(84.57, 184.83, 351.48, 14.17),
    "KomNr": FieldRect(478.77, 184.80, 71.16, 14.17),
    "Stundenvorgabe": FieldRect(120.36, 243.75, 111.24, 11.34),
    "ca Auftragswert": FieldRect(402.60, 243.75, 146.76, 11.34),
    "Ausführender Freitext": FieldRect(353.27, 281.80, 97.80, 11.34),
    "Arbeitsbeschreibung": FieldRect(62.68, 304.00, 488.00, 18.00),
    "Ort": FieldRect(62.42, 318.39, 124.68, 14.17),
    "Datum_2": FieldRect(240.32, 318.39, 124.68, 14.17),
    "Zusatzstundenachweis Nr": FieldRect(236.88, 351.12, 106.80, 17.01),
    "für die Zeit vom": FieldRect(434.76, 356.79, 48.96, 11.34),
    "bis": FieldRect(502.08, 356.79, 48.96, 11.34),
    "Bauteil": FieldRect(86.69, 379.59, 61.20, 11.34),
    "Etage": FieldRect(199.92, 379.59, 61.20, 11.34),
    "Raum Nr": FieldRect(328.08, 379.59, 55.68, 11.34),
    "Achse": FieldRect(440.16, 379.59, 61.08, 11.34),
    "Gesamt Std": FieldRect(345.96, 609.56, 68.16, 14.17),
    "BemerkungenRow1": FieldRect(416.48, 445.92, 136.08, 176.76),
    "Material": FieldRect(62.76, 641.85, 484.92, 54.80),
}

CHECKBOX_CENTERS = {
    "flat_rate": (167.24, 223.12),
    "hourly": (238.05, 223.16),
    "unit_price": (344.51, 223.20),
    "material_yes": (167.28, 269.67),
    "material_no": (190.31, 269.67),
    "material_separate_attachment": (238.09, 269.67),
    "lead_monteur": (167.15, 288.56),
    "monteur": (238.09, 288.52),
    "helper": (299.86, 288.50),
    "executor_other": (344.42, 288.50),
}

SIGNATURE_IMAGE_BOX_Y = 56.0
MONTEUR_SIG_IMAGE_BOX = (68.0, SIGNATURE_IMAGE_BOX_Y, 145.0, 24.0)
MONTEUR_PLACE_CENTER_X = 102.0
MONTEUR_DATE_CENTER_X = 181.0
CUSTOMER_SIG_IMAGE_BOX = (402.0, SIGNATURE_IMAGE_BOX_Y, 145.0, 24.0)
CUSTOMER_PLACE_CENTER_X = 435.0
CUSTOMER_DATE_CENTER_X = 514.0
SIGNATURE_VALUE_BASELINE_Y = 99.0
SIGNATURE_VALUE_FONT_SIZE = 6.5
SIGNATURE_PLACE_MAX_WIDTH = 72.0
SIGNATURE_DATE_MAX_WIDTH = 58.0
CUSTOMER_ORDERED_BY_NAME_X = 86.0
CUSTOMER_ORDERED_BY_NAME_Y = 672.0
CUSTOMER_ORDERED_BY_NAME_MAX_WIDTH = 345.0
CUSTOMER_ORDERED_BY_NAME_FONT_SIZE = 8.5

WORKER_NAME_RECTS = (
    FieldRect(57.48, 446.97, 101.76, 45.72),
    FieldRect(57.48, 494.97, 101.76, 45.72),
    FieldRect(57.48, 542.97, 101.76, 45.72),
)
HOUR_FIELD_NAMES = tuple(
    tuple(
        tuple(
            [
                *(f"S{worker_index * 21 + category_index * 7 + day_index + 1}" for day_index in range(7)),
                f"G{worker_index * 3 + category_index + 1}",
            ]
        )
        for category_index in range(3)
    )
    for worker_index in range(3)
)
HOUR_DAY_X = (184.68, 207.61, 230.48, 253.68, 276.56, 299.76, 321.97)
HOUR_FIELD_RECTS: dict[str, FieldRect] = {}
for worker_index, worker_y in enumerate((446.25, 494.25, 542.25)):
    for category_index in range(3):
        row_y = worker_y + category_index * 16.08
        names = HOUR_FIELD_NAMES[worker_index][category_index]
        for day_index, day_x in enumerate(HOUR_DAY_X):
            HOUR_FIELD_RECTS[names[day_index]] = FieldRect(day_x, row_y, 21.36, 14.52)
        HOUR_FIELD_RECTS[names[-1]] = FieldRect(345.96, row_y, 68.16, 14.52)


class ExtraWorkPdfService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def build_mobile_ticket_pdf(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> tuple[bytes, str]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket(ticket_id, assignment.site_id)
        started_at = perf_counter()
        filename = self._build_filename(ticket)
        version_hash = self._build_ticket_pdf_version_hash(ticket, assignment)
        content, cache_hit = DocumentPdfCache().get_or_build(
            cache_key=f"extra-work-{ticket.id}",
            version_hash=version_hash,
            build=lambda: self._build_ticket_pdf(ticket=ticket, assignment=assignment),
        )
        LOGGER.info(
            "Extra work PDF served: ticket_id=%s photos=%s cache_hit=%s bytes=%s duration_ms=%.1f",
            ticket.id,
            len(ticket.photos or []),
            cache_hit,
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content, filename

    def build_site_ticket_pdf(
        self,
        *,
        site_id: int,
        ticket_id: int,
    ) -> tuple[bytes, str]:
        ticket = self._get_ticket(ticket_id, site_id)
        assignment = self._get_site_assignment_context(ticket)
        started_at = perf_counter()
        filename = self._build_filename(ticket)
        version_hash = self._build_ticket_pdf_version_hash(ticket, assignment)
        content, cache_hit = DocumentPdfCache().get_or_build(
            cache_key=f"extra-work-{ticket.id}",
            version_hash=version_hash,
            build=lambda: self._build_ticket_pdf(ticket=ticket, assignment=assignment),
        )
        LOGGER.info(
            "Extra work site PDF served: ticket_id=%s photos=%s cache_hit=%s bytes=%s duration_ms=%.1f",
            ticket.id,
            len(ticket.photos or []),
            cache_hit,
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content, filename

    def build_clean_template_pdf(self) -> bytes:
        """Return the shared visual master without interactive PDF state."""
        if not TEMPLATE_PATH.exists():
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Zusatzauftrag-Vorlage fehlt.",
            )
        return _build_clean_template_pdf_cached(TEMPLATE_PATH, TEMPLATE_PATH.stat().st_mtime_ns)

    def _build_ticket_pdf_version_hash(self, ticket: ExtraWorkTicket, assignment: Assignment | None) -> str:
        return build_pdf_version_hash({
            "type": "extra_work",
            "generator_version": EXTRA_WORK_PDF_CACHE_VERSION,
            "template_mtime": TEMPLATE_PATH.stat().st_mtime if TEMPLATE_PATH.exists() else None,
            "ticket": {
                "id": ticket.id,
                "sequence_number": ticket.sequence_number,
                "display_number": ticket.display_number,
                "title": ticket.title,
                "kind": ticket.kind,
                "status": ticket.status,
                "manual_order_date": ticket.manual_order_date,
                "manual_execution_week": ticket.manual_execution_week,
                "manual_execution_week_year": ticket.manual_execution_week_year,
                "manual_execution_start": ticket.manual_execution_start,
                "manual_execution_end": ticket.manual_execution_end,
                "ordered_by_name": ticket.ordered_by_name,
                "ordered_by_company": ticket.ordered_by_company,
                "billing_type": ticket.billing_type,
                "estimated_order_value": ticket.estimated_order_value,
                "material_required": ticket.material_required,
                "material_separate_attachment": ticket.material_separate_attachment,
                "executed_by_lead_monteur": ticket.executed_by_lead_monteur,
                "executed_by_monteur": ticket.executed_by_monteur,
                "executed_by_helper": ticket.executed_by_helper,
                "executor_other_name": ticket.executor_other_name,
                "work_description": ticket.work_description,
                "updated_at": ticket.updated_at,
                "submitted_at": ticket.submitted_at,
                "customer_signature_type": ticket.customer_signature_type,
                "customer_signature_name": ticket.customer_signature_name,
                "customer_signature_place": ticket.customer_signature_place,
                "customer_signature_strokes": ticket.customer_signature_strokes,
                "customer_signed_at": ticket.customer_signed_at,
                "worker_signature_name": ticket.worker_signature_name,
                "worker_signature_place": ticket.worker_signature_place,
                "worker_signature_date": ticket.worker_signature_date,
                "worker_signature_strokes": ticket.worker_signature_strokes,
                "worker_signed_at": ticket.worker_signed_at,
            },
            "site": {
                "id": ticket.site.id if ticket.site else None,
                "number": ticket.site.site_number if ticket.site else None,
                "name": ticket.site.name if ticket.site else None,
                "customer": ticket.site.customer if ticket.site else None,
                "updated_at": ticket.site.updated_at if ticket.site else None,
            },
            "assignment": {
                "id": assignment.id if assignment else None,
                "start_date": assignment.start_date if assignment else None,
                "end_date": assignment.end_date if assignment else None,
                "updated_at": assignment.updated_at if assignment else None,
            },
            "entries": [
                {
                    "id": entry.id,
                    "component": entry.component,
                    "floor": entry.floor,
                    "room_number": entry.room_number,
                    "axis": entry.axis,
                    "remarks": entry.remarks,
                    "material_text": entry.material_text,
                    "material_items": entry.material_items,
                    "estimated_hours": entry.estimated_hours,
                    "worker_rows": entry.worker_rows,
                    "updated_at": entry.updated_at,
                }
                for entry in sorted(ticket.entries or [], key=lambda entry: entry.id)
            ],
            "approval": [
                {
                    "id": entry.id,
                    "estimated_hours": entry.estimated_hours,
                    "worker_rows": entry.worker_rows,
                    "updated_at": entry.updated_at,
                }
                for entry in sorted(
                    ticket.approval_ticket.entries if ticket.approval_ticket else [],
                    key=lambda entry: entry.id,
                )
            ],
            "photos": [
                {
                    "id": photo.id,
                    "filename": photo.filename,
                    "external_item_id": photo.external_item_id,
                    "file_size_bytes": photo.file_size_bytes,
                    "caption": photo.caption,
                    "updated_at": photo.updated_at,
                }
                for photo in sorted(ticket.photos or [], key=lambda photo: photo.id)
            ],
        })

    def _build_ticket_pdf(self, *, ticket: ExtraWorkTicket, assignment: Assignment | None) -> bytes:
        if not TEMPLATE_PATH.exists():
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Zusatzauftrag-Vorlage fehlt.")
        started_at = perf_counter()
        entries = list(ticket.entries or [])
        entry = entries[0] if entries else None
        worker_rows = list(entry.worker_rows or []) if entry else []
        chunks = _chunk(worker_rows or [], 3) or [[]]
        clean_template = self.build_clean_template_pdf()
        overlay_reader = PdfReader(BytesIO(self._build_overlay_pdf(ticket, assignment, entry, chunks)))
        writer = PdfWriter()
        for index, _chunk_rows in enumerate(chunks):
            # A fresh reader per sheet is intentional: pypdf otherwise reuses
            # translated indirect objects for repeated copies of the same
            # template page. Merging a later overlay would then mutate the
            # shared /Contents tree, stacking all overlays on page one and
            # leaving following pages blank.
            template_reader = PdfReader(BytesIO(clean_template))
            writer.add_page(template_reader.pages[0])
            page = writer.pages[-1]
            page.merge_page(overlay_reader.pages[index])
        self._append_photo_pages(writer, ticket)
        output = BytesIO()
        _remove_interactive_pdf_state(writer)
        writer.write(output)
        content = output.getvalue()
        LOGGER.info(
            "Extra work PDF generated: ticket_id=%s photos=%s bytes=%s duration_ms=%.1f",
            ticket.id,
            len(ticket.photos or []),
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content

    def _append_photo_pages(self, writer: PdfWriter, ticket: ExtraWorkTicket) -> None:
        photos = sorted(ticket.photos or [], key=lambda photo: (photo.created_at, photo.id))
        if not photos:
            return
        folder_item_id = self._get_photo_folder_item_id(ticket.site_id)
        if folder_item_id is None:
            LOGGER.warning("Extra work photo folder is not connected for site %s.", ticket.site_id)
            return

        download_started_at = perf_counter()
        storage = ProjectStorageService()
        download_results = download_photo_files(
            storage,
            [
                PhotoDownloadRequest(
                    drive_id=photo.external_drive_id,
                    folder_item_id=folder_item_id,
                    item_id=photo.external_item_id,
                )
                for photo in photos
            ],
        )
        LOGGER.info(
            "Extra work PDF photos downloaded: ticket_id=%s photos=%s bytes=%s duration_ms=%.1f",
            ticket.id,
            len(download_results),
            sum(len(result.content) for result in download_results),
            (perf_counter() - download_started_at) * 1000,
        )

        appendix_photos: list[PhotoAppendixPhoto] = []
        for photo, result in zip(photos, download_results, strict=True):
            if result.error is not None:
                LOGGER.warning(
                    "Extra work photo %s could not be downloaded for PDF: %s",
                    photo.id,
                    result.error,
                )
            LOGGER.info(
                "Extra work PDF photo loaded: ticket_id=%s photo_id=%s source_bytes=%s duration_ms=%.1f",
                ticket.id,
                photo.id,
                len(result.content),
                result.duration_ms,
            )
            appendix_photos.append(
                PhotoAppendixPhoto(
                    filename=photo.filename,
                    content=result.content,
                    caption=photo.caption,
                    uploaded_at=photo.created_at,
                    monteur=_format_user(photo.uploaded_by),
                )
            )
        if not appendix_photos:
            return

        site = ticket.site
        appendix_content = PhotoAppendixPdfService().build(
            context=PhotoAppendixContext(
                document_type="Zusatzauftrag",
                site_name=site.name,
                site_number=site.site_number,
                site_address=_format_site_signature_location(site),
                process_title=_ticket_document_description(ticket),
                document_number_label="Zusatzauftrag Nr.",
                document_number=ticket.display_number or str(ticket.sequence_number),
                generated_at=datetime.now(),
                uploaded_at=max(photo.created_at for photo in photos),
                monteur=_common_photo_monteur(photos),
            ),
            photos=appendix_photos,
        )
        appendix_reader = PdfReader(BytesIO(appendix_content))
        for page in appendix_reader.pages:
            writer.add_page(page)

    def _get_photo_folder_item_id(self, site_id: int) -> str | None:
        folder = self.db.scalar(
            select(ProjectFolder).where(
                ProjectFolder.site_id == site_id,
                ProjectFolder.folder_key == EXTRA_WORK_PHOTO_FOLDER_KEY,
                ProjectFolder.is_active.is_(True),
            )
        )
        return folder.external_item_id if folder and folder.external_item_id else None

    def _build_overlay_pdf(
        self,
        ticket: ExtraWorkTicket,
        assignment: Assignment | None,
        entry: ExtraWorkTicketEntry | None,
        chunks: list[list[dict[str, Any]]],
    ) -> bytes:
        pdf = OverlayPdf()
        for page_index, rows in enumerate(chunks):
            commands: list[bytes] = []
            self._draw_common_fields(commands, ticket, assignment, entry, page_index + 1, len(chunks))
            if ticket.kind == "approval":
                self._draw_approval_fields(commands, ticket, assignment, entry)
            self._draw_billing_fields(commands, ticket, assignment, entry, rows)
            if page_index == len(chunks) - 1:
                self._draw_signature_fields(commands, ticket)
            pdf.add_page(commands)
        return pdf.build()

    def _draw_common_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        assignment: Assignment | None,
        entry: ExtraWorkTicketEntry | None,
        page_number: int,
        total_pages: int,
    ) -> None:
        site = ticket.site
        document_dates = resolve_extra_work_ticket_dates(ticket, assignment)
        _field(commands, FIELD_RECTS["Kunde"], site.customer or "")
        _field(commands, FIELD_RECTS["Projekt"], site.name)
        _field(commands, FIELD_RECTS["Datum"], _format_date(document_dates.order_date))
        _field(
            commands,
            FIELD_RECTS["Herrn"],
            ticket.ordered_by_name or ticket.customer_signature_name or "",
        )
        _field(
            commands,
            FIELD_RECTS["Firma"],
            ticket.ordered_by_company or site.customer or "",
        )
        _field(
            commands,
            FIELD_RECTS["KomNr"],
            site.site_number or "",
            size=10.5,
            align="center",
            font="F2",
            fill=BEG_PDF_RED,
        )
        billing_type = ticket.billing_type or "hourly"
        if billing_type in {"flat_rate", "hourly", "unit_price"}:
            _checkbox(commands, *CHECKBOX_CENTERS[billing_type])
        if ticket.estimated_order_value is not None:
            _field(
                commands,
                FIELD_RECTS["ca Auftragswert"],
                _format_currency(ticket.estimated_order_value),
                size=8,
                align="right",
            )
        estimated_hours = entry.estimated_hours if entry else None
        if (
            estimated_hours is None
            and ticket.kind == "billing"
            and ticket.approval_ticket_id
            and ticket.approval_ticket
        ):
            estimated_hours = ticket.approval_ticket.estimated_hours
        if estimated_hours is not None:
            _field(
                commands,
                FIELD_RECTS["Stundenvorgabe"],
                _format_decimal(estimated_hours),
                size=8,
            )

        material_output = _format_extra_work_material(entry)
        material_required = ticket.material_required
        if material_required is None:
            material_required = bool(material_output)
        if material_required:
            _checkbox(commands, *CHECKBOX_CENTERS["material_yes"])
        else:
            _checkbox(commands, *CHECKBOX_CENTERS["material_no"])
        if ticket.material_separate_attachment:
            _checkbox(commands, *CHECKBOX_CENTERS["material_separate_attachment"])

        executor_flags = (
            ticket.executed_by_lead_monteur,
            ticket.executed_by_monteur,
            ticket.executed_by_helper,
        )
        use_legacy_monteur_default = all(
            flag is None for flag in executor_flags
        ) and not ticket.executor_other_name
        if ticket.executed_by_lead_monteur:
            _checkbox(commands, *CHECKBOX_CENTERS["lead_monteur"])
        if ticket.executed_by_monteur or use_legacy_monteur_default:
            _checkbox(commands, *CHECKBOX_CENTERS["monteur"])
        if ticket.executed_by_helper:
            _checkbox(commands, *CHECKBOX_CENTERS["helper"])
        if ticket.executor_other_name:
            _checkbox(commands, *CHECKBOX_CENTERS["executor_other"])
            _field(
                commands,
                FIELD_RECTS["Ausführender Freitext"],
                ticket.executor_other_name,
                size=7.5,
            )
        if ticket.work_description:
            _white_rect(commands, FIELD_RECTS["Arbeitsbeschreibung"])
            _textarea(
                commands,
                FIELD_RECTS["Arbeitsbeschreibung"],
                ticket.work_description,
                size=5.2,
                max_lines=2,
            )
        _field(
            commands,
            FIELD_RECTS["Zusatzstundenachweis Nr"],
            _ticket_number(ticket, page_number, total_pages),
            size=10.5,
            font="F2",
            fill=BEG_PDF_RED,
        )
        title = _clean_text(ticket.title)
        if title:
            _field(commands, FieldRect(236.88, 366.00, 313.00, 10.00), title, size=7.1)
        _field(
            commands,
            FIELD_RECTS["für die Zeit vom"],
            _format_date(document_dates.execution_start),
            size=7.0,
            align="center",
        )
        _field(
            commands,
            FIELD_RECTS["bis"],
            _format_date(document_dates.execution_end),
            size=7.0,
            align="center",
        )
        if entry:
            _field(commands, _shift_rect(FIELD_RECTS["Bauteil"], dy=2.0), entry.component, size=9)
            _field(commands, _shift_rect(FIELD_RECTS["Etage"], dy=2.0), entry.floor, size=9)
            _field(commands, _shift_rect(FIELD_RECTS["Raum Nr"], dy=2.0), entry.room_number or "", size=9)
            _field(commands, _shift_rect(FIELD_RECTS["Achse"], dy=2.0), entry.axis or "", size=9)
            _textarea(commands, FIELD_RECTS["BemerkungenRow1"], entry.remarks or "", size=7.5, max_lines=13)
            _material_textarea(
                commands,
                FIELD_RECTS["Material"],
                entry,
                size=8,
                max_lines=3,
                line_height=18,
            )

    def _draw_approval_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        assignment: Assignment | None,
        entry: ExtraWorkTicketEntry | None,
    ) -> None:
        document_dates = resolve_extra_work_ticket_dates(ticket, assignment)
        _field(
            commands,
            FIELD_RECTS["Ort"],
            resolve_extra_work_approval_place(ticket) or "",
            size=8,
        )
        _field(
            commands,
            FIELD_RECTS["Datum_2"],
            _format_date(document_dates.approval_date),
            size=8,
        )

    def _draw_billing_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        assignment: Assignment | None,
        entry: ExtraWorkTicketEntry | None,
        rows: list[dict[str, Any]],
    ) -> None:
        total = Decimal("0")
        for index, row in enumerate(rows[:3]):
            _centered_textarea(
                commands,
                WORKER_NAME_RECTS[index],
                str(row.get("worker_name") or ""),
                size=8.3,
                max_lines=2,
            )
            for category_index, category_keys in enumerate(WORKER_HOUR_CATEGORY_KEYS):
                field_names = HOUR_FIELD_NAMES[index][category_index]
                category_total = Decimal("0")
                for weekday_index, key in enumerate(category_keys):
                    value = _decimal(row.get(key))
                    if value <= 0:
                        continue
                    _field(
                        commands,
                        HOUR_FIELD_RECTS[field_names[weekday_index]],
                        _format_decimal(value),
                        size=8,
                        align="center",
                    )
                    category_total += value
                if category_total > 0:
                    _field(
                        commands,
                        HOUR_FIELD_RECTS[field_names[-1]],
                        _format_decimal(category_total),
                        size=8,
                        align="center",
                    )
                    total += category_total
        if total > 0:
            _field(commands, FIELD_RECTS["Gesamt Std"], _format_decimal(total), size=9, align="center")

    def _draw_signature_fields(self, commands: list[bytes], ticket: ExtraWorkTicket) -> None:
        worker_place = ticket.worker_signature_place or _format_site_signature_location(ticket.site)
        worker_date = ticket.worker_signature_date or (
            ticket.worker_signed_at.date() if ticket.worker_signed_at else None
        )
        customer_place = ticket.customer_signature_place or worker_place

        _signature_stamp(
            commands,
            strokes=ticket.worker_signature_strokes,
            image_box=MONTEUR_SIG_IMAGE_BOX,
            place_center_x=MONTEUR_PLACE_CENTER_X,
            date_center_x=MONTEUR_DATE_CENTER_X,
            signature_date=worker_date,
            place=worker_place,
        )
        _signature_stamp(
            commands,
            strokes=ticket.customer_signature_strokes,
            image_box=CUSTOMER_SIG_IMAGE_BOX,
            place_center_x=CUSTOMER_PLACE_CENTER_X,
            date_center_x=CUSTOMER_DATE_CENTER_X,
            signature_date=ticket.customer_signed_at.date() if ticket.customer_signed_at else None,
            place=customer_place,
        )

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
        assignment = self.db.scalar(
            select(Assignment).options(selectinload(Assignment.person)).where(
                Assignment.id == assignment_id,
                Assignment.person_id == current_user.person_id,
            )
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        return assignment

    def _get_ticket(self, ticket_id: int, site_id: int) -> ExtraWorkTicket:
        ticket = self.db.scalar(
            select(ExtraWorkTicket)
            .options(
                selectinload(ExtraWorkTicket.created_by).selectinload(User.person),
                selectinload(ExtraWorkTicket.site),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.approval_ticket).selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.photos).selectinload(
                    ExtraWorkTicketPhoto.uploaded_by
                ).selectinload(User.person),
            )
            .where(
                ExtraWorkTicket.id == ticket_id,
                ExtraWorkTicket.site_id == site_id,
                ExtraWorkTicket.deleted_at.is_(None),
            )
        )
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    def _get_site_assignment_context(self, ticket: ExtraWorkTicket) -> Assignment | None:
        return get_extra_work_assignment_context(self.db, ticket)

    @staticmethod
    def _build_filename(ticket: ExtraWorkTicket) -> str:
        site_number = _safe_filename_part(ticket.site.site_number or "ohne-komnr")
        ticket_number = _safe_filename_part(ticket.display_number or str(ticket.sequence_number))
        return f"Zusatzauftrag_{site_number}_{ticket_number}.pdf"


@lru_cache(maxsize=2)
def _build_clean_template_pdf_cached(template_path: Path, _mtime_ns: int) -> bytes:
    reader = PdfReader(str(template_path))
    if not reader.pages:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Zusatzauftrag-Vorlage enthält keine Seite.",
        )
    writer = PdfWriter()
    page = deepcopy(reader.pages[0])
    _remove_page_annotations(page)
    writer.add_page(page)
    _remove_interactive_pdf_state(writer)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _remove_page_annotations(page: Any) -> None:
    for key in ("/Annots", "/AA"):
        if key in page:
            del page[key]


def _remove_interactive_pdf_state(writer: PdfWriter) -> None:
    root = writer._root_object
    for key in ("/AcroForm", "/Names", "/OpenAction", "/AA"):
        if key in root:
            del root[key]


class OverlayPdf:
    def __init__(self) -> None:
        self.pages: list[bytes] = []

    def add_page(self, commands: list[bytes]) -> None:
        self.pages.append(b"\n".join(commands))

    def build(self) -> bytes:
        objects: list[bytes] = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ]
        page_object_numbers: list[int] = []
        for page_stream in self.pages:
            stream_object_number = len(objects) + 1
            objects.append(
                b"<< /Length "
                + str(len(page_stream)).encode("ascii")
                + b" >>\nstream\n"
                + page_stream
                + b"\nendstream"
            )
            page_object_numbers.append(len(objects) + 1)
            objects.append(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
                + _number(PAGE_WIDTH)
                + b" "
                + _number(PAGE_HEIGHT)
                + b"] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents "
                + str(stream_object_number).encode("ascii")
                + b" 0 R >>"
            )
        kids = b" ".join(str(number).encode("ascii") + b" 0 R" for number in page_object_numbers)
        objects[1] = (
            b"<< /Type /Pages /Kids ["
            + kids
            + b"] /Count "
            + str(len(page_object_numbers)).encode("ascii")
            + b" >>"
        )
        buffer = BytesIO()
        buffer.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for index, obj in enumerate(objects, start=1):
            offsets.append(buffer.tell())
            buffer.write(str(index).encode("ascii") + b" 0 obj\n")
            buffer.write(obj)
            buffer.write(b"\nendobj\n")
        xref_start = buffer.tell()
        buffer.write(b"xref\n")
        buffer.write(f"0 {len(objects) + 1}\n".encode("ascii"))
        buffer.write(b"0000000000 65535 f \n")
        for offset in offsets[1:]:
            buffer.write(f"{offset:010d} 00000 n \n".encode("ascii"))
        buffer.write(b"trailer\n")
        buffer.write(
            b"<< /Size "
            + str(len(objects) + 1).encode("ascii")
            + b" /Root 1 0 R >>\nstartxref\n"
            + str(xref_start).encode("ascii")
            + b"\n%%EOF\n"
        )
        return buffer.getvalue()


def _field(
    commands: list[bytes],
    rect: FieldRect,
    text: str,
    *,
    size: float = 8.5,
    align: str = "left",
    font: str = "F1",
    fill: tuple[float, float, float] | None = None,
) -> None:
    value = _clean_text(text)
    if not value:
        return
    baseline = PAGE_HEIGHT - rect.y - rect.height + (rect.height - size) / 2 + 2.0
    x = rect.x + 2.0
    if align == "center":
        x = rect.x + rect.width / 2 - _text_width(value, size) / 2
    elif align == "right":
        x = rect.x + rect.width - _text_width(value, size) - 2.0
    _text(commands, x, baseline, _fit_text(value, rect.width - 4, size), size, font=font, fill=fill)


def _textarea(
    commands: list[bytes],
    rect: FieldRect,
    text: str,
    *,
    size: float,
    max_lines: int,
    line_height: float | None = None,
) -> None:
    lines = _wrap_text(_clean_multiline_text(text), rect.width - 4, size, max_lines)
    _draw_textarea_lines(commands, rect, lines, size=size, line_height=line_height)


def _material_textarea(
    commands: list[bytes],
    rect: FieldRect,
    entry: ExtraWorkTicketEntry,
    *,
    size: float,
    max_lines: int,
    line_height: float | None = None,
) -> None:
    lines = _wrap_extra_work_material(
        entry,
        rect.width - 4,
        size,
        max_lines,
    )
    _draw_textarea_lines(commands, rect, lines, size=size, line_height=line_height)


def _draw_textarea_lines(
    commands: list[bytes],
    rect: FieldRect,
    lines: list[str],
    *,
    size: float,
    line_height: float | None = None,
) -> None:
    if not lines:
        return
    actual_line_height = line_height or size + 2.0
    for index, line in enumerate(lines):
        baseline = PAGE_HEIGHT - rect.y - size - 2.0 - index * actual_line_height
        if baseline < PAGE_HEIGHT - rect.y - rect.height + 2:
            break
        _text(commands, rect.x + 2.0, baseline, line, size)


def _centered_textarea(commands: list[bytes], rect: FieldRect, text: str, *, size: float, max_lines: int) -> None:
    lines = _wrap_text(_clean_text(text), rect.width - 8, size, max_lines)
    if not lines:
        return
    line_height = size + 2.2
    block_height = len(lines) * line_height
    bottom_y = PAGE_HEIGHT - rect.y - rect.height
    block_bottom = bottom_y + max((rect.height - block_height) / 2, 0)
    for index, line in enumerate(lines):
        baseline = block_bottom + (len(lines) - index - 1) * line_height + (line_height - size) / 2
        x = rect.x + rect.width / 2 - _text_width(line, size) / 2
        _text(commands, x, baseline, line, size)


def _shift_rect(rect: FieldRect, *, dx: float = 0, dy: float = 0) -> FieldRect:
    return FieldRect(rect.x + dx, rect.y + dy, rect.width, rect.height)


def _white_rect(commands: list[bytes], rect: FieldRect) -> None:
    commands.append(
        b"q 1 1 1 rg "
        + _number(rect.x)
        + b" "
        + _number(PAGE_HEIGHT - rect.y - rect.height)
        + b" "
        + _number(rect.width)
        + b" "
        + _number(rect.height)
        + b" re f Q"
    )


def _signature_stamp(
    commands: list[bytes],
    *,
    strokes: list[list[dict[str, float]]] | None,
    image_box: tuple[float, float, float, float],
    place_center_x: float,
    date_center_x: float,
    signature_date: date | None,
    place: str,
) -> None:
    image_x, image_y, image_width, image_height = image_box
    _draw_signature(commands, strokes, x=image_x, y=image_y, width=image_width, height=image_height)
    _centered_value(
        commands,
        center_x=place_center_x,
        y=SIGNATURE_VALUE_BASELINE_Y,
        text=_signature_place_short(place),
        max_width=SIGNATURE_PLACE_MAX_WIDTH,
        size=SIGNATURE_VALUE_FONT_SIZE,
    )
    _centered_value(
        commands,
        center_x=date_center_x,
        y=SIGNATURE_VALUE_BASELINE_Y,
        text=_format_signature_date(signature_date),
        max_width=SIGNATURE_DATE_MAX_WIDTH,
        size=SIGNATURE_VALUE_FONT_SIZE,
    )


def _centered_value(
    commands: list[bytes],
    *,
    center_x: float,
    y: float,
    text: str,
    max_width: float,
    size: float,
) -> None:
    value = _fit_text(_clean_text(text), max_width, size)
    if not value:
        return
    _text(commands, center_x - _text_width(value, size) / 2, y, value, size)


def _checkbox(commands: list[bytes], center_x: float, center_y_top: float) -> None:
    _text(commands, center_x - 2.8, PAGE_HEIGHT - center_y_top - 3.3, "X", 7.5)


def _text(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: float,
    font: str = "F1",
    fill: tuple[float, float, float] | None = None,
) -> None:
    text_command = (
        b"BT /"
        + font.encode("ascii")
        + b" "
        + _number(size)
        + b" Tf "
        + _number(x)
        + b" "
        + _number(y)
        + b" Td "
        + _pdf_string(text)
        + b" Tj ET"
    )
    if fill is not None:
        commands.append(
            b"q "
            + _number(fill[0])
            + b" "
            + _number(fill[1])
            + b" "
            + _number(fill[2])
            + b" rg "
            + text_command
            + b" Q"
        )
        return
    commands.append(text_command)


def _draw_signature(
    commands: list[bytes],
    strokes: list[list[dict[str, float]]] | None,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
) -> None:
    if not strokes:
        return

    source_aspect_ratio = 3.0
    target_aspect_ratio = width / height if height > 0 else source_aspect_ratio
    if target_aspect_ratio > source_aspect_ratio:
        drawing_width = height * source_aspect_ratio
        drawing_height = height
        drawing_x = x + (width - drawing_width) / 2
        drawing_y = y
    else:
        drawing_width = width
        drawing_height = width / source_aspect_ratio
        drawing_x = x
        drawing_y = y + (height - drawing_height) / 2

    for stroke in strokes:
        points: list[tuple[float, float]] = []
        for point in stroke:
            if not isinstance(point, dict):
                continue
            try:
                point_x = float(point.get("x", 0))
                point_y = float(point.get("y", 0))
            except (TypeError, ValueError):
                continue
            if not (0 <= point_x <= 1 and 0 <= point_y <= 1):
                continue
            points.append(
                (
                    drawing_x + point_x * drawing_width,
                    drawing_y + (1 - point_y) * drawing_height,
                )
            )
        if len(points) < 2:
            continue

        first_x, first_y = points[0]
        path_parts = [_number(first_x), _number(first_y), b"m"]
        for next_x, next_y in points[1:]:
            path_parts.extend([_number(next_x), _number(next_y), b"l"])
        path_parts.append(b"S")
        commands.append(b"q 1.25 w 0.05 0.12 0.24 RG " + b" ".join(path_parts) + b" Q")


def _format_user(user: User | None) -> str | None:
    if user is None:
        return None
    if user.person and user.person.display_name:
        return user.person.display_name
    return user.display_name


def _common_photo_monteur(photos: list[ExtraWorkTicketPhoto]) -> str | None:
    names = {
        name
        for photo in photos
        if (name := _format_user(photo.uploaded_by))
    }
    if len(names) == 1:
        return next(iter(names))
    if len(names) > 1:
        return "Mehrere Monteure"
    return None


def _format_signature_date(value: date | None) -> str:
    if value is None:
        return ""
    return value.strftime("%d.%m.%Y")


def _format_site_signature_location(site: Any | None) -> str:
    if site is None:
        return ""
    street_parts = [
        _clean_text(getattr(site, "street", None)),
        _clean_text(getattr(site, "house_number", None)),
    ]
    city_parts = [
        _clean_text(getattr(site, "postal_code", None)),
        _clean_text(getattr(site, "city", None)),
    ]
    structured = ", ".join(
        part
        for part in [
            " ".join(part for part in street_parts if part),
            " ".join(part for part in city_parts if part),
        ]
        if part
    )
    if structured:
        return structured
    for attribute in ("address", "location", "city"):
        value = _clean_text(getattr(site, attribute, None))
        if value:
            return value
    return ""


def _signature_place_short(place: str | None) -> str:
    value = _clean_text(place)
    if not value:
        return ""
    candidate = value.split(",")[-1].strip()
    parts = candidate.split()
    if parts and len(parts[0]) == 5 and parts[0].isdigit():
        candidate = " ".join(parts[1:])
    if candidate:
        return candidate
    parts = value.split()
    for index, part in enumerate(parts):
        if len(part) == 5 and part.isdigit() and index + 1 < len(parts):
            return " ".join(parts[index + 1 :])
    return value


TextWidthMeasure = Callable[[str, float], float]


def _wrap_text(
    text: str,
    width: float,
    size: float,
    max_lines: int,
    *,
    text_width: TextWidthMeasure | None = None,
) -> list[str]:
    measure = text_width or _text_width
    wrapped_lines: list[str] = []
    paragraphs = text.split("\n")
    for paragraph_index, paragraph in enumerate(paragraphs):
        words = paragraph.split()
        if not words:
            if paragraph_index > 0 and wrapped_lines:
                wrapped_lines.append("")
            continue
        wrapped_lines.extend(_wrap_words(words, width, size, measure))

    truncated = len(wrapped_lines) > max_lines
    lines = wrapped_lines[:max_lines]
    if truncated and lines:
        lines[-1] = _fit_text(
            lines[-1],
            width,
            size,
            suffix="...",
            text_width=measure,
        )
    return lines


def _wrap_words(
    words: list[str],
    width: float,
    size: float,
    measure: TextWidthMeasure,
) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if measure(candidate, size) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if measure(word, size) <= width:
            current = word
            continue
        fragments = _split_token_to_width(word, width, size, measure)
        lines.extend(fragments[:-1])
        current = fragments[-1] if fragments else ""
    if current:
        lines.append(current)
    return lines


def _split_token_to_width(
    token: str,
    width: float,
    size: float,
    measure: TextWidthMeasure,
) -> list[str]:
    fragments: list[str] = []
    current = ""
    for character in token:
        candidate = current + character
        if current and measure(candidate, size) > width:
            fragments.append(current)
            current = character
        else:
            current = candidate
    if current:
        fragments.append(current)
    return fragments


def _fit_text(
    text: str,
    width: float,
    size: float,
    *,
    suffix: str = "",
    text_width: TextWidthMeasure | None = None,
) -> str:
    measure = text_width or _text_width
    if measure(text, size) <= width:
        return text
    trimmed = text
    while trimmed and measure(trimmed + suffix, size) > width:
        trimmed = trimmed[:-1]
    return (trimmed.rstrip() + suffix) if trimmed else ""


def _text_width(text: str, size: float) -> float:
    return len(text) * size * 0.48


def _pdf_font_text_width(text: str, size: float) -> float:
    return stringWidth(text, "Helvetica", size)


def _pdf_string(value: str) -> bytes:
    encoded = value.encode("cp1252", errors="replace")
    escaped = encoded.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + escaped + b")"


def _number(value: float | Decimal) -> bytes:
    return f"{float(value):.2f}".rstrip("0").rstrip(".").encode("ascii")


def _clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\r", " ").split())


def _clean_multiline_text(value: str | None) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n")


def _format_extra_work_material(entry: ExtraWorkTicketEntry | None) -> str:
    if entry is None:
        return ""
    sections: list[str] = []
    legacy_text = _clean_multiline_text(entry.material_text).strip()
    if legacy_text:
        sections.append(legacy_text)
    item_lines = _format_extra_work_material_items(entry)
    if item_lines:
        sections.append("; ".join(item_lines))
    return "\n".join(sections)


def _format_extra_work_material_items(entry: ExtraWorkTicketEntry | None) -> list[str]:
    if entry is None:
        return []
    item_lines: list[str] = []
    for item in entry.material_items or []:
        description = _clean_text(str(item.get("description") or ""))
        if not description:
            continue
        quantity = item.get("quantity")
        unit = _clean_text(str(item.get("unit") or ""))
        if quantity is None:
            item_lines.append(description)
            continue
        formatted_quantity = _format_decimal(quantity)
        quantity_label = (
            f"{formatted_quantity}x"
            if unit.casefold() == "x"
            else " ".join(part for part in (formatted_quantity, unit) if part)
        )
        item_lines.append(f"{quantity_label} {description}".strip())
    return item_lines


def _wrap_extra_work_material(
    entry: ExtraWorkTicketEntry | None,
    width: float,
    size: float,
    max_lines: int,
) -> list[str]:
    if entry is None:
        return []
    lines: list[str] = []
    legacy_text = _clean_multiline_text(entry.material_text).strip()
    if legacy_text:
        lines.extend(
            _wrap_text(
                legacy_text,
                width,
                size,
                max_lines=10_000,
                text_width=_pdf_font_text_width,
            )
        )
    item_lines = _format_extra_work_material_items(entry)
    if item_lines:
        lines.extend(_wrap_material_positions(item_lines, width, size))
    if len(lines) <= max_lines:
        return lines
    visible_lines = lines[:max_lines]
    visible_lines[-1] = _fit_text(
        visible_lines[-1],
        width,
        size,
        suffix="...",
        text_width=_pdf_font_text_width,
    )
    return visible_lines


def _wrap_material_positions(
    positions: list[str],
    width: float,
    size: float,
) -> list[str]:
    lines: list[str] = []
    current = ""
    for index, position in enumerate(positions):
        piece = position + (";" if index < len(positions) - 1 else "")
        candidate = f"{current} {piece}".strip()
        if _pdf_font_text_width(candidate, size) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
        wrapped_piece = _wrap_text(
            piece,
            width,
            size,
            max_lines=10_000,
            text_width=_pdf_font_text_width,
        )
        lines.extend(wrapped_piece[:-1])
        current = wrapped_piece[-1] if wrapped_piece else ""
    if current:
        lines.append(current)
    return lines


def _date_from_datetime(value: datetime | None) -> date:
    return value.date() if value else date.today()


def _format_date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def _format_decimal(value: Decimal | float | int | str) -> str:
    decimal_value = _decimal(value)
    if decimal_value == decimal_value.to_integral():
        return str(decimal_value.quantize(Decimal("1"))).replace(".", ",")
    return f"{decimal_value.normalize():f}".replace(".", ",")


def _format_currency(value: Decimal | float | int | str) -> str:
    decimal_value = _decimal(value)
    formatted = f"{decimal_value:,.2f}"
    return formatted.replace(",", "_").replace(".", ",").replace("_", ".") + " €"


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0")).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _ticket_number(ticket: ExtraWorkTicket, page_number: int, total_pages: int) -> str:
    number = ticket.display_number or str(ticket.sequence_number)
    return f"{number} / Blatt {page_number}" if total_pages > 1 else number


def _ticket_title_suffix(ticket: ExtraWorkTicket) -> str:
    return _clean_text(ticket.title) or "Hauptauftrag"


def _ticket_document_description(ticket: ExtraWorkTicket) -> str:
    return _clean_text(ticket.title) or "Zusatzarbeiten"


def _safe_filename_part(value: str) -> str:
    cleaned = "".join("_" if char in '/\\:*?"<>| ' else char for char in value.strip())
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_") or "ohne-angabe"


def _chunk(values: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [values[index:index + size] for index in range(0, len(values), size)]
