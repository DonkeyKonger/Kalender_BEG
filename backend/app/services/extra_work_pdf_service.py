from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from pypdf import PdfReader, PdfWriter
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
from app.models.user import User

PAGE_WIDTH = 595.28
PAGE_HEIGHT = 841.89
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
        output = BytesIO()
        writer.write(output)
        return output.getvalue()

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


def _text(commands: list[bytes], x: float, y: float, text: str, size: float) -> None:
    commands.append(
        b"BT /F1 "
        + _number(size)
        + b" Tf "
        + _number(x)
        + b" "
        + _number(y)
        + b" Td "
        + _pdf_string(text)
        + b" Tj ET"
    )


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


def _safe_filename_part(value: str) -> str:
    cleaned = "".join("_" if char in '/\\:*?"<>| ' else char for char in value.strip())
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_") or "ohne-angabe"


def _chunk(values: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [values[index:index + size] for index in range(0, len(values), size)]
