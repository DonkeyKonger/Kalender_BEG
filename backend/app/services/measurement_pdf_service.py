from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from io import BytesIO
from textwrap import wrap

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.site_measurement_item import (
    SiteMeasurementBatch,
    SiteMeasurementEntry,
)
from app.models.user import User


PAGE_WIDTH = 841.89
PAGE_HEIGHT = 595.276
MARGIN = 32


@dataclass(frozen=True)
class PdfLine:
    text: str
    size: int = 8
    font: str = "F1"


class SimplePdf:
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


class MeasurementPdfService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def build_batch_pdf(self, *, site_id: int, batch_id: int) -> tuple[bytes, str]:
        batch = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.site),
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
            )
            .where(SiteMeasurementBatch.id == batch_id, SiteMeasurementBatch.site_id == site_id)
        )
        if batch is None or batch.site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        if batch.status not in {"billed", "approved"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "PDF-Export ist erst für abgerechnete Aufmaße verfügbar.",
            )

        pdf = SimplePdf()
        rows = self._build_rows(batch)
        page_rows = _chunk(rows, 18)
        for page_index, rows_on_page in enumerate(page_rows or [[]], start=1):
            pdf.add_page(self._render_page(batch, rows_on_page, page_index, len(page_rows or [[]])))

        file_number = _format_batch_number(batch.site.site_number, batch.number)
        safe_number = file_number.replace("/", "-").replace(" ", "_")
        return pdf.build(), f"Aufmass_{safe_number}.pdf"

    def _build_rows(self, batch: SiteMeasurementBatch) -> list[list[str]]:
        entries = sorted(
            batch.entries,
            key=lambda entry: (
                entry.measurement_item.sort_order if entry.measurement_item else 0,
                entry.measurement_item.position if entry.measurement_item else "",
                entry.area_or_comment,
                entry.id,
            ),
        )
        rows: list[list[str]] = []
        current_item_id: int | None = None
        current_total = Decimal("0")
        current_unit = ""

        for entry in entries:
            item = entry.measurement_item
            if item is None:
                continue
            if current_item_id is not None and item.id != current_item_id:
                rows.append(["", "", "", "Summe Position", _format_decimal(current_total), current_unit])
                current_total = Decimal("0")
            current_item_id = item.id
            current_unit = item.unit or ""
            current_total += entry.quantity
            rows.append(
                [
                    item.position,
                    item.description,
                    item.unit or "",
                    entry.area_or_comment,
                    _format_decimal(entry.quantity),
                    "",
                ]
            )

        if current_item_id is not None:
            rows.append(["", "", "", "Summe Position", _format_decimal(current_total), current_unit])
        return rows

    def _render_page(
        self,
        batch: SiteMeasurementBatch,
        rows: list[list[str]],
        page_number: int,
        page_count: int,
    ) -> list[bytes]:
        site = batch.site
        assert site is not None
        commands: list[bytes] = [b"1 w"]
        title = _format_batch_number(site.site_number, batch.number)
        submitted_by = _format_user(batch.submitted_by) or "-"
        submitted_at = _format_datetime(batch.submitted_at)
        address = " ".join(part for part in [site.street, site.house_number] if part)
        city = " ".join(part for part in [site.postal_code, site.city] if part)
        project_address = ", ".join(part for part in [address or site.address, city] if part) or "-"

        _text(commands, MARGIN, PAGE_HEIGHT - 36, "BEG Aufmaß", 16, "F2")
        _text(commands, PAGE_WIDTH - 230, PAGE_HEIGHT - 34, f"Aufmaß {title}", 14, "F2")
        _text(commands, PAGE_WIDTH - 230, PAGE_HEIGHT - 52, f"Blatt-Nr.: {page_number}/{page_count}", 9)
        _line(commands, MARGIN, PAGE_HEIGHT - 62, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 62)

        y = PAGE_HEIGHT - 84
        y = _field(commands, MARGIN, y, "Kunde:", site.customer or "-")
        y = _field(commands, MARGIN, y, "Projekt/Bauvorhaben:", site.name)
        y = _field(commands, MARGIN, y, "Kommissions-Nr.:", site.site_number or "-")
        y = _field(commands, MARGIN, y, "Adresse:", project_address)

        info_x = 520
        info_y = PAGE_HEIGHT - 84
        info_y = _field(commands, info_x, info_y, "Datum:", _format_date(datetime.now()))
        info_y = _field(commands, info_x, info_y, "Status:", _status_label(batch.status))
        info_y = _field(commands, info_x, info_y, "Monteur:", submitted_by)
        _field(commands, info_x, info_y, "Eingereicht:", submitted_at or "-")

        table_top = PAGE_HEIGHT - 190
        _table_header(commands, table_top)
        y = table_top - 24
        for row in rows:
            row_height = _table_row(commands, y, row)
            y -= row_height

        if page_number == page_count:
            total = sum((entry.quantity for entry in batch.entries), Decimal("0"))
            _text(commands, 614, 98, "Gesamtsumme:", 9, "F2")
            _text(commands, 704, 98, _format_decimal(total), 9, "F2")
            _signature_block(commands)

        return commands


def _table_header(commands: list[bytes], y: float) -> None:
    headers = ["Pos. lt. Bestellung", "Art der Leistung", "Einheit", "Bauteil / Abschnitt", "Menge", "Summe"]
    widths = [92, 300, 54, 190, 70, 70]
    x = MARGIN
    _rect(commands, MARGIN, y - 22, sum(widths), 22)
    for header, width in zip(headers, widths, strict=True):
        _text(commands, x + 4, y - 14, header, 7, "F2")
        _line(commands, x, y - 22, x, y)
        x += width
    _line(commands, x, y - 22, x, y)


def _table_row(commands: list[bytes], y: float, row: list[str]) -> float:
    widths = [92, 300, 54, 190, 70, 70]
    line_counts = [
        max(1, len(_wrapped(value, max(8, int(width / 5.2)))))
        for value, width in zip(row, widths, strict=True)
    ]
    height = max(18, max(line_counts) * 9 + 6)
    _rect(commands, MARGIN, y - height, sum(widths), height)
    x = MARGIN
    for value, width in zip(row, widths, strict=True):
        _line(commands, x, y - height, x, y)
        lines = _wrapped(value, max(8, int(width / 5.2)))[:4]
        for index, line in enumerate(lines):
            text_x = x + width - 6 if width <= 70 and value else x + 4
            _text(commands, text_x, y - 11 - index * 8, line, 7, "F2" if row[3] == "Summe Position" else "F1", align_right=width <= 70)
        x += width
    _line(commands, x, y - height, x, y)
    return height


def _signature_block(commands: list[bytes]) -> None:
    _line(commands, MARGIN, 82, PAGE_WIDTH - MARGIN, 82)
    _text(commands, MARGIN, 68, "Die Richtigkeit des Aufmaßes und die ordnungsgemäße Montage bescheinigen:", 8)
    _text(commands, MARGIN, 44, "Ort / Datum:", 8, "F2")
    _line(commands, 92, 42, 250, 42)
    _text(commands, 284, 44, "Name Auftragnehmer (BEG):", 8, "F2")
    _line(commands, 420, 42, 560, 42)
    _text(commands, 594, 44, "Unterschrift:", 8, "F2")
    _line(commands, 664, 42, 800, 42)
    _text(commands, 284, 22, "Name Auftraggeber (Kunde):", 8, "F2")
    _line(commands, 420, 20, 560, 20)
    _text(commands, 594, 22, "Unterschrift:", 8, "F2")
    _line(commands, 664, 20, 800, 20)


def _field(commands: list[bytes], x: float, y: float, label: str, value: str) -> float:
    _text(commands, x, y, label, 8, "F2")
    _text(commands, x + 108, y, value, 8)
    return y - 16


def _wrapped(value: str, width: int) -> list[str]:
    text = " ".join((value or "").split())
    return wrap(text, width=width, break_long_words=False) or [""]


def _chunk(rows: list[list[str]], size: int) -> list[list[list[str]]]:
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def _format_batch_number(site_number: str | None, number: int) -> str:
    prefix = site_number or "Aufmaß"
    return f"{prefix}.{number:02d}" if site_number else f"Aufmaß {number}"


def _format_decimal(value: Decimal) -> str:
    return f"{value:.2f}".replace(".", ",")


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


def _format_date(value: datetime) -> str:
    return value.strftime("%d.%m.%Y")


def _status_label(status_value: str) -> str:
    return {
        "billed": "Abgerechnet",
        "approved": "Abgerechnet",
        "submitted": "Noch offen",
        "rejected": "Noch offen",
        "draft": "Entwurf",
    }.get(status_value, status_value)


def _text(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: int,
    font: str = "F1",
    *,
    align_right: bool = False,
) -> None:
    text_width = len(text) * size * 0.48
    text_x = x - text_width if align_right else x
    commands.append(
        b"BT /"
        + font.encode("ascii")
        + b" "
        + str(size).encode("ascii")
        + b" Tf "
        + _number(text_x)
        + b" "
        + _number(y)
        + b" Td "
        + _pdf_string(text)
        + b" Tj ET"
    )


def _line(commands: list[bytes], x1: float, y1: float, x2: float, y2: float) -> None:
    commands.append(b" ".join([_number(x1), _number(y1), b"m", _number(x2), _number(y2), b"l S"]))


def _rect(commands: list[bytes], x: float, y: float, width: float, height: float) -> None:
    commands.append(
        b" ".join([_number(x), _number(y), _number(width), _number(height), b"re S"])
    )


def _number(value: float) -> bytes:
    return f"{value:.2f}".rstrip("0").rstrip(".").encode("ascii")


def _pdf_string(value: str) -> bytes:
    encoded = value.encode("cp1252", errors="replace")
    escaped = encoded.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + escaped + b")"
