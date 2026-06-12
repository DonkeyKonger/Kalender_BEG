from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO
import logging
from pathlib import Path
from time import perf_counter
import zlib
from typing import Any

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.project_folder import ProjectFolder
from app.models.user import User
from app.services.photo_limits import MAX_PHOTO_DIMENSION
from app.services.project_storage_service import ProjectStorageService

PAGE_WIDTH = 595.28
PAGE_HEIGHT = 841.89
PHOTO_MAX_IMAGE_EDGE = MAX_PHOTO_DIMENSION
EXTRA_WORK_PHOTO_FOLDER_KEY = "fotos"
LOGGER = logging.getLogger(__name__)
TEMPLATE_PATH = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "extra_work"
    / "Zusatzauftrag_Vorlage_BEG_Intelligent.pdf"
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


@dataclass(frozen=True)
class FieldRect:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class PdfImage:
    width: int
    height: int
    data: bytes


FIELD_RECTS = {
    "Kunde": FieldRect(103.20, 119.20, 204.72, 14.17),
    "Projekt": FieldRect(363.85, 119.20, 186.84, 14.17),
    "Herrn": FieldRect(84.19, 157.23, 351.61, 14.17),
    "Datum": FieldRect(479.58, 157.20, 71.16, 14.17),
    "Firma": FieldRect(84.57, 184.83, 351.48, 14.17),
    "KomNr": FieldRect(478.77, 184.80, 71.16, 14.17),
    "Stundenvorgabe": FieldRect(120.36, 243.75, 111.24, 11.34),
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
    "hourly": (238.05, 223.16),
    "material_yes": (167.28, 269.67),
    "material_no": (190.31, 269.67),
    "monteur": (238.09, 288.52),
}

WORKER_NAME_RECTS = (
    FieldRect(57.48, 446.97, 101.76, 45.72),
    FieldRect(57.48, 494.97, 101.76, 45.72),
    FieldRect(57.48, 542.97, 101.76, 45.72),
)
NORMAL_HOUR_FIELD_NAMES = (
    ("S1", "S2", "S3", "S4", "S5", "S6", "S7", "G1"),
    ("S22", "S23", "S24", "S25", "S26", "S27", "S28", "G4"),
    ("S43", "S44", "S45", "S46", "S47", "S48", "S49", "G7"),
)
HOUR_FIELD_RECTS = {
    "S1": FieldRect(184.68, 446.25, 21.36, 14.52),
    "S2": FieldRect(207.61, 446.25, 21.36, 14.52),
    "S3": FieldRect(230.48, 446.25, 21.36, 14.52),
    "S4": FieldRect(253.68, 446.25, 21.36, 14.52),
    "S5": FieldRect(276.56, 446.25, 21.36, 14.52),
    "S6": FieldRect(299.76, 446.25, 21.36, 14.52),
    "S7": FieldRect(321.97, 446.25, 21.36, 14.52),
    "G1": FieldRect(345.96, 446.25, 68.16, 14.52),
    "S22": FieldRect(184.68, 494.25, 21.36, 14.52),
    "S23": FieldRect(207.61, 494.25, 21.36, 14.52),
    "S24": FieldRect(230.48, 494.25, 21.36, 14.52),
    "S25": FieldRect(253.68, 494.25, 21.36, 14.52),
    "S26": FieldRect(276.56, 494.25, 21.36, 14.52),
    "S27": FieldRect(299.76, 494.25, 21.36, 14.52),
    "S28": FieldRect(321.97, 494.25, 21.36, 14.52),
    "G4": FieldRect(345.96, 494.25, 68.16, 14.52),
    "S43": FieldRect(184.68, 542.25, 21.36, 14.52),
    "S44": FieldRect(207.61, 542.25, 21.36, 14.52),
    "S45": FieldRect(230.48, 542.25, 21.36, 14.52),
    "S46": FieldRect(253.68, 542.25, 21.36, 14.52),
    "S47": FieldRect(276.56, 542.25, 21.36, 14.52),
    "S48": FieldRect(299.76, 542.25, 21.36, 14.52),
    "S49": FieldRect(321.97, 542.25, 21.36, 14.52),
    "G7": FieldRect(345.96, 542.25, 68.16, 14.52),
}


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
        content = self._build_ticket_pdf(ticket=ticket, assignment=assignment)
        return content, self._build_filename(ticket)

    def _build_ticket_pdf(self, *, ticket: ExtraWorkTicket, assignment: Assignment) -> bytes:
        if not TEMPLATE_PATH.exists():
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Zusatzauftrag-Vorlage fehlt.")
        started_at = perf_counter()
        entries = list(ticket.entries or [])
        entry = entries[0] if entries else None
        worker_rows = list(entry.worker_rows or []) if entry else []
        chunks = _chunk(worker_rows or [], 3) or [[]]
        template_reader = PdfReader(str(TEMPLATE_PATH))
        overlay_reader = PdfReader(BytesIO(self._build_overlay_pdf(ticket, assignment, entry, chunks)))
        writer = PdfWriter()
        template_page = template_reader.pages[0]
        for index, _chunk_rows in enumerate(chunks):
            writer.add_page(deepcopy(template_page))
            page = writer.pages[-1]
            if "/Annots" in page:
                del page["/Annots"]
            page.merge_page(overlay_reader.pages[index])
        self._append_photo_pages(writer, ticket)
        output = BytesIO()
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

        appendix_pdf = PhotoAppendixPdf()
        appended_count = 0
        for photo in photos:
            try:
                downloaded = ProjectStorageService().download_file_from_folder(
                    drive_id=photo.external_drive_id,
                    folder_item_id=folder_item_id,
                    item_id=photo.external_item_id,
                )
                image = _load_uploaded_image_rgb(downloaded["content"])
            except (HTTPException, OSError, UnidentifiedImageError, ValueError) as error:
                LOGGER.warning("Extra work photo %s could not be added to PDF: %s", photo.id, error)
                continue
            appended_count += 1
            image_name = f"ExtraWorkPhoto{photo.id}"
            appendix_pdf.add_image(image_name, image)
            appendix_pdf.add_page(
                _render_photo_attachment_page(
                    ticket=ticket,
                    photo=photo,
                    image=image,
                    image_name=image_name,
                    index=appended_count,
                    total=len(photos),
                )
            )
        if appended_count == 0:
            return

        appendix_reader = PdfReader(BytesIO(appendix_pdf.build()))
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
        assignment: Assignment,
        entry: ExtraWorkTicketEntry | None,
        chunks: list[list[dict[str, Any]]],
    ) -> bytes:
        pdf = OverlayPdf()
        for page_index, rows in enumerate(chunks):
            commands: list[bytes] = []
            self._draw_common_fields(commands, ticket, assignment, entry, page_index + 1, len(chunks))
            if ticket.kind == "approval":
                self._draw_approval_fields(commands, ticket, entry)
            self._draw_billing_fields(commands, ticket, assignment, entry, rows)
            if page_index == len(chunks) - 1:
                self._draw_signature_fields(commands, ticket)
            pdf.add_page(commands)
        return pdf.build()

    def _draw_common_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        assignment: Assignment,
        entry: ExtraWorkTicketEntry | None,
        page_number: int,
        total_pages: int,
    ) -> None:
        site = ticket.site
        created_date = _date_from_datetime(ticket.created_at)
        _field(commands, FIELD_RECTS["Kunde"], site.customer or "")
        _field(commands, FIELD_RECTS["Projekt"], site.name)
        _field(commands, FIELD_RECTS["Datum"], _format_date(created_date))
        _field(commands, FIELD_RECTS["Firma"], site.customer or "")
        _field(commands, FIELD_RECTS["KomNr"], site.site_number or "")
        _checkbox(commands, *CHECKBOX_CENTERS["hourly"])
        _checkbox(commands, *CHECKBOX_CENTERS["monteur"])
        if entry and entry.material_text:
            _checkbox(commands, *CHECKBOX_CENTERS["material_yes"])
        else:
            _checkbox(commands, *CHECKBOX_CENTERS["material_no"])
        _field(commands, FIELD_RECTS["Zusatzstundenachweis Nr"], _ticket_number(ticket, page_number, total_pages), size=9)
        _field(commands, FieldRect(346.00, 351.12, 204.00, 17.01), _ticket_title_suffix(ticket), size=8)
        week_start, week_end = _week_range(assignment.start_date or created_date)
        _field(commands, FIELD_RECTS["für die Zeit vom"], _format_date(week_start), size=7.6, align="center")
        _field(commands, FIELD_RECTS["bis"], _format_date(week_end), size=7.6, align="center")
        if entry:
            _field(commands, FIELD_RECTS["Bauteil"], entry.component, size=8)
            _field(commands, FIELD_RECTS["Etage"], entry.floor, size=8)
            _field(commands, FIELD_RECTS["Raum Nr"], entry.room_number or "", size=8)
            _field(commands, FIELD_RECTS["Achse"], entry.axis or "", size=8)
            _textarea(commands, FIELD_RECTS["BemerkungenRow1"], entry.remarks or "", size=7.5, max_lines=13)
            _textarea(commands, FIELD_RECTS["Material"], entry.material_text or "", size=8, max_lines=3)

    def _draw_approval_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        entry: ExtraWorkTicketEntry | None,
    ) -> None:
        if entry and entry.estimated_hours is not None:
            _field(commands, FIELD_RECTS["Stundenvorgabe"], _format_decimal(entry.estimated_hours), size=8)
        created_date = _date_from_datetime(ticket.created_at)
        _field(commands, FIELD_RECTS["Ort"], ticket.site.city or ticket.site.location or "", size=8)
        _field(commands, FIELD_RECTS["Datum_2"], _format_date(created_date), size=8)
        if entry and entry.remarks:
            _textarea(commands, FieldRect(62.68, 313.00, 480.00, 12.00), entry.remarks, size=7.5, max_lines=1)

    def _draw_billing_fields(
        self,
        commands: list[bytes],
        ticket: ExtraWorkTicket,
        assignment: Assignment,
        entry: ExtraWorkTicketEntry | None,
        rows: list[dict[str, Any]],
    ) -> None:
        total = Decimal("0")
        for index, row in enumerate(rows[:3]):
            _textarea(commands, WORKER_NAME_RECTS[index], str(row.get("worker_name") or ""), size=8, max_lines=2)
            field_names = NORMAL_HOUR_FIELD_NAMES[index]
            row_total = Decimal("0")
            for weekday_index, key in enumerate(WEEKDAY_KEYS):
                value = _decimal(row.get(key))
                if value > 0:
                    _field(commands, HOUR_FIELD_RECTS[field_names[weekday_index]], _format_decimal(value), size=8, align="center")
                    row_total += value
            if row_total > 0:
                _field(commands, HOUR_FIELD_RECTS[field_names[-1]], _format_decimal(row_total), size=8, align="center")
                total += row_total
        if rows:
            _field(commands, FIELD_RECTS["Gesamt Std"], _format_decimal(total), size=9, align="center")

        if ticket.kind == "billing" and ticket.approval_ticket_id and ticket.approval_ticket:
            approval_estimate = ticket.approval_ticket.estimated_hours
            if approval_estimate is not None:
                _field(commands, FIELD_RECTS["Stundenvorgabe"], _format_decimal(approval_estimate), size=8)

    def _draw_signature_fields(self, commands: list[bytes], ticket: ExtraWorkTicket) -> None:
        signature_y = 38
        column_width = 224
        worker_x = 62
        customer_x = 315

        _text(commands, worker_x, signature_y + 42, "Unterschrift Monteur", 8, font="F2")
        _text(commands, customer_x, signature_y + 42, "Unterschrift Kunde", 8, font="F2")

        _text(commands, worker_x, signature_y + 26, "Name:", 6.8, font="F2")
        _text(commands, customer_x, signature_y + 26, "Name:", 6.8, font="F2")
        _text(commands, worker_x + 34, signature_y + 26, ticket.worker_signature_name or "", 7)
        _text(commands, customer_x + 34, signature_y + 26, ticket.customer_signature_name or "", 7)

        _text(commands, worker_x, signature_y + 12, "Datum:", 6.8, font="F2")
        _text(commands, customer_x, signature_y + 12, "Datum:", 6.8, font="F2")
        _text(commands, worker_x + 40, signature_y + 12, _format_date_from_datetime(ticket.worker_signed_at), 7)
        _text(commands, customer_x + 40, signature_y + 12, _format_date_from_datetime(ticket.customer_signed_at), 7)

        customer_place = ticket.customer_signature_place or _format_site_signature_location(ticket.site)
        if customer_place:
            _text(commands, customer_x, signature_y - 2, "Ort:", 6.8, font="F2")
            _text(commands, customer_x + 24, signature_y - 2, _fit_text(customer_place, 176, 6.8), 6.8)

        _line(commands, worker_x, signature_y + 4, worker_x + column_width, signature_y + 4, 0.6)
        _line(commands, customer_x, signature_y + 4, customer_x + column_width, signature_y + 4, 0.6)
        _draw_signature(commands, ticket.worker_signature_strokes, x=worker_x + 102, y=signature_y + 6, width=112, height=34)
        _draw_signature(commands, ticket.customer_signature_strokes, x=customer_x + 102, y=signature_y + 6, width=112, height=34)

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
        assignment = self.db.scalar(
            select(Assignment).where(
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
                selectinload(ExtraWorkTicket.site),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.approval_ticket).selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.photos).selectinload(
                    ExtraWorkTicketPhoto.uploaded_by
                ).selectinload(User.person),
            )
            .where(ExtraWorkTicket.id == ticket_id, ExtraWorkTicket.site_id == site_id)
        )
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    @staticmethod
    def _build_filename(ticket: ExtraWorkTicket) -> str:
        site_number = _safe_filename_part(ticket.site.site_number or "ohne-komnr")
        ticket_number = _safe_filename_part(ticket.display_number or str(ticket.sequence_number))
        return f"Zusatzauftrag_{site_number}_{ticket_number}.pdf"


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
                + b"] /Resources << /Font << /F1 3 0 R >> >> /Contents "
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


class PhotoAppendixPdf:
    def __init__(self) -> None:
        self.pages: list[bytes] = []
        self.images: dict[str, PdfImage] = {}

    def add_image(self, name: str, image: PdfImage) -> None:
        self.images[name] = image

    def add_page(self, commands: list[bytes]) -> None:
        self.pages.append(b"\n".join(commands))

    def build(self) -> bytes:
        objects: list[bytes] = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ]
        image_object_numbers: dict[str, int] = {}
        for name, image in self.images.items():
            objects.append(
                b"<< /Type /XObject /Subtype /Image /Width "
                + str(image.width).encode("ascii")
                + b" /Height "
                + str(image.height).encode("ascii")
                + b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length "
                + str(len(image.data)).encode("ascii")
                + b" >>\nstream\n"
                + image.data
                + b"\nendstream"
            )
            image_object_numbers[name] = len(objects)

        xobject_resource = b""
        if image_object_numbers:
            xobjects = b" ".join(
                b"/" + name.encode("ascii") + b" " + str(number).encode("ascii") + b" 0 R"
                for name, number in image_object_numbers.items()
            )
            xobject_resource = b" /XObject << " + xobjects + b" >>"

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
                + b"] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>"
                + xobject_resource
                + b" >> /Contents "
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


def _field(commands: list[bytes], rect: FieldRect, text: str, *, size: float = 8.5, align: str = "left") -> None:
    value = _clean_text(text)
    if not value:
        return
    baseline = PAGE_HEIGHT - rect.y - rect.height + (rect.height - size) / 2 + 2.0
    x = rect.x + 2.0
    if align == "center":
        x = rect.x + rect.width / 2 - _text_width(value, size) / 2
    elif align == "right":
        x = rect.x + rect.width - _text_width(value, size) - 2.0
    _text(commands, x, baseline, _fit_text(value, rect.width - 4, size), size)


def _textarea(commands: list[bytes], rect: FieldRect, text: str, *, size: float, max_lines: int) -> None:
    lines = _wrap_text(_clean_text(text), rect.width - 4, size, max_lines)
    if not lines:
        return
    line_height = size + 2.0
    for index, line in enumerate(lines):
        baseline = PAGE_HEIGHT - rect.y - size - 2.0 - index * line_height
        if baseline < PAGE_HEIGHT - rect.y - rect.height + 2:
            break
        _text(commands, rect.x + 2.0, baseline, line, size)


def _checkbox(commands: list[bytes], center_x: float, center_y_top: float) -> None:
    _text(commands, center_x - 2.8, PAGE_HEIGHT - center_y_top - 3.3, "X", 7.5)


def _render_photo_attachment_page(
    *,
    ticket: ExtraWorkTicket,
    photo: ExtraWorkTicketPhoto,
    image: PdfImage,
    image_name: str,
    index: int,
    total: int,
) -> list[bytes]:
    ticket_label = _ticket_display_title(ticket)
    uploaded_by = _format_user(photo.uploaded_by) or "-"
    commands: list[bytes] = [b"1 1 1 rg 0 0 595.28 841.89 re f 0 0 0 RG 0 0 0 rg"]
    _text(commands, 42, 782, "Fotoanlagen", 18, font="F2")
    _text(commands, 42, 758, f"{ticket_label} · {ticket.site.name}", 9)
    _text(commands, 42, 733, f"Foto {index} von {total}", 9, font="F2")
    _text(commands, 42, 716, f"Datei: {photo.filename}", 8)
    _text(commands, 42, 702, f"Hochgeladen: {_format_datetime(photo.created_at) or '-'}", 8)
    _text(commands, 42, 688, f"Monteur: {uploaded_by}", 8)
    _line(commands, 42, 672, 553, 672, 0.8)
    _image_fit(commands, image_name, x=42, y=64, max_width=511, max_height=590, image=image)
    return commands


def _line(commands: list[bytes], x1: float, y1: float, x2: float, y2: float, width: float = 0.5) -> None:
    commands.append(
        _number(width)
        + b" w "
        + _number(x1)
        + b" "
        + _number(y1)
        + b" m "
        + _number(x2)
        + b" "
        + _number(y2)
        + b" l S"
    )


def _text(commands: list[bytes], x: float, y: float, text: str, size: float, font: str = "F1") -> None:
    commands.append(
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


def _image(commands: list[bytes], name: str, x: float, y: float, width: float, height: float) -> None:
    commands.append(
        b"q "
        + b" ".join([_number(width), b"0", b"0", _number(height), _number(x), _number(y)])
        + b" cm /"
        + name.encode("ascii")
        + b" Do Q"
    )


def _image_fit(
    commands: list[bytes],
    name: str,
    *,
    x: float,
    y: float,
    max_width: float,
    max_height: float,
    image: PdfImage,
) -> None:
    scale = min(max_width / image.width, max_height / image.height)
    width = image.width * scale
    height = image.height * scale
    fitted_x = x + (max_width - width) / 2
    fitted_y = y + (max_height - height) / 2
    _image(commands, name, fitted_x, fitted_y, width, height)


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
            points.append((x + point_x * width, y + (1 - point_y) * height))
        if len(points) < 2:
            continue

        first_x, first_y = points[0]
        path_parts = [_number(first_x), _number(first_y), b"m"]
        for next_x, next_y in points[1:]:
            path_parts.extend([_number(next_x), _number(next_y), b"l"])
        path_parts.append(b"S")
        commands.append(b"q 1.25 w 0.05 0.12 0.24 RG " + b" ".join(path_parts) + b" Q")


def _load_uploaded_image_rgb(content: bytes) -> PdfImage:
    with Image.open(BytesIO(content)) as source:
        image = ImageOps.exif_transpose(source)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA")
        image.thumbnail((PHOTO_MAX_IMAGE_EDGE, PHOTO_MAX_IMAGE_EDGE))
        rgb = Image.new("RGB", image.size, "white")
        if image.mode == "RGBA":
            rgb.paste(image, mask=image.getchannel("A"))
        else:
            rgb.paste(image)
        width, height = rgb.size
        return PdfImage(width=width, height=height, data=zlib.compress(rgb.tobytes(), 9))


def _format_user(user: User | None) -> str | None:
    if user is None:
        return None
    if user.person and user.person.display_name:
        return user.person.display_name
    return user.display_name


def _format_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.strftime("%d.%m.%Y, %H:%M")


def _format_date_from_datetime(value: datetime | None) -> str:
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


def _wrap_text(text: str, width: float, size: float, max_lines: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        next_line = f"{current} {word}".strip()
        if _text_width(next_line, size) <= width:
            current = next_line
            continue
        if current:
            lines.append(current)
        current = word
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and words:
        joined = " ".join(words)
        if " ".join(lines) != joined:
            lines[-1] = _fit_text(lines[-1], width, size, suffix="...")
    return lines


def _fit_text(text: str, width: float, size: float, *, suffix: str = "") -> str:
    if _text_width(text, size) <= width:
        return text
    trimmed = text
    while trimmed and _text_width(trimmed + suffix, size) > width:
        trimmed = trimmed[:-1]
    return (trimmed.rstrip() + suffix) if trimmed else ""


def _text_width(text: str, size: float) -> float:
    return len(text) * size * 0.48


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


def _date_from_datetime(value: datetime | None) -> date:
    return value.date() if value else date.today()


def _week_range(value: date) -> tuple[date, date]:
    start = value - timedelta(days=value.weekday())
    return start, start + timedelta(days=6)


def _format_date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def _format_decimal(value: Decimal | float | int | str) -> str:
    decimal_value = _decimal(value)
    if decimal_value == decimal_value.to_integral():
        return str(decimal_value.quantize(Decimal("1"))).replace(".", ",")
    return f"{decimal_value.normalize():f}".replace(".", ",")


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0")).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _ticket_number(ticket: ExtraWorkTicket, page_number: int, total_pages: int) -> str:
    number = ticket.display_number or str(ticket.sequence_number)
    return f"{number} / Blatt {page_number}" if total_pages > 1 else number


def _ticket_display_title(ticket: ExtraWorkTicket) -> str:
    prefix = "Stundenfreigabe" if ticket.kind == "approval" else "Stundenzettel"
    return f"{prefix} {ticket.sequence_number} - {_ticket_title_suffix(ticket)}"


def _ticket_title_suffix(ticket: ExtraWorkTicket) -> str:
    return _clean_text(ticket.title) or "Hauptauftrag"


def _safe_filename_part(value: str) -> str:
    cleaned = "".join("_" if char in '/\\:*?"<>| ' else char for char in value.strip())
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_") or "ohne-angabe"


def _chunk(values: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [values[index:index + size] for index in range(0, len(values), size)]
