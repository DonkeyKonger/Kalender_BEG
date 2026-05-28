from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
import struct
from textwrap import wrap
import zlib

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
TABLE_LEFT = 50.8
TABLE_RIGHT = 763.6
TABLE_TOP = PAGE_HEIGHT - 174.6
MATRIX_POSITION_BOTTOM = PAGE_HEIGHT - 196.2
MATRIX_DESCRIPTION_BOTTOM = PAGE_HEIGHT - 316.4
MATRIX_UNIT_BOTTOM = PAGE_HEIGHT - 336.6
MATRIX_TOTAL_TOP = PAGE_HEIGHT - 504.7
MATRIX_BOTTOM = PAGE_HEIGHT - 518.8
MATRIX_X = 232.6
MATRIX_COLUMN_BOUNDARIES = (
    232.6,
    273.2,
    313.2,
    353.2,
    395.3,
    437.4,
    479.2,
    519.1,
    559.4,
    600.1,
    642.2,
    684.4,
    724.3,
    763.6,
)
MAX_POSITIONS_PER_SHEET = 13
MATRIX_COLUMN_COUNT = MAX_POSITIONS_PER_SHEET
MATRIX_AREA_ROW_HEIGHT = 14
MATRIX_AREA_ROW_LINES = tuple(
    PAGE_HEIGHT - top_y
    for top_y in (
        336.6,
        351.4,
        365.4,
        379.4,
        393.1,
        407.2,
        421.2,
        435.2,
        449.3,
        463.3,
        477.4,
        491.4,
        504.7,
    )
)
MATRIX_AREA_ROW_COUNT = len(MATRIX_AREA_ROW_LINES) - 1
MATRIX_AREA_LABEL_X = 94.7
MATRIX_AREA_LABEL_WIDTH = MATRIX_X - MATRIX_AREA_LABEL_X
MATRIX_SECTION_LABEL_RIGHT = 94.9
LOGO_RESOURCE_NAME = "ImLogo"
LOGO_PATH = Path(__file__).resolve().parents[1] / "assets" / "beg_logo_icon.png"


@dataclass(frozen=True)
class MatrixPosition:
    item_id: int
    position: str
    description: str
    unit: str
    sort_order: int


@dataclass(frozen=True)
class MatrixArea:
    key: str
    label: str


@dataclass(frozen=True)
class PdfImage:
    width: int
    height: int
    data: bytes


class SimplePdf:
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
        logo = _load_png_rgb(LOGO_PATH)
        if logo is not None:
            pdf.add_image(LOGO_RESOURCE_NAME, logo)
        positions, areas, cells, totals_by_position = self._build_matrix(batch)
        position_pages = _chunk(positions, MATRIX_COLUMN_COUNT) or [[]]
        area_pages = _chunk(areas, MATRIX_AREA_ROW_COUNT) or [[]]
        page_count = len(position_pages) * len(area_pages)
        page_number = 1
        for position_page_index, position_page in enumerate(position_pages, start=1):
            for area_page_index, area_page in enumerate(area_pages, start=1):
                pdf.add_page(
                    self._render_page(
                        batch=batch,
                        positions=position_page,
                        areas=area_page,
                        cells=cells,
                        totals_by_position=totals_by_position,
                        page_number=page_number,
                        page_count=page_count,
                        position_page_index=position_page_index,
                        area_page_index=area_page_index,
                        logo=logo,
                    )
                )
                page_number += 1

        file_number = _format_batch_number(batch.site.site_number, batch.number)
        safe_number = file_number.replace("/", "-").replace(" ", "_")
        return pdf.build(), f"Aufmass_{safe_number}.pdf"

    def _build_matrix(
        self, batch: SiteMeasurementBatch
    ) -> tuple[
        list[MatrixPosition],
        list[MatrixArea],
        dict[tuple[str, int], Decimal],
        dict[int, Decimal],
    ]:
        entries = sorted(
            batch.entries,
            key=lambda entry: (
                entry.measurement_item.sort_order if entry.measurement_item else 0,
                entry.measurement_item.position if entry.measurement_item else "",
                entry.area_or_comment,
                entry.id,
            ),
        )
        positions_by_id: dict[int, MatrixPosition] = {}
        area_by_key: dict[str, MatrixArea] = {}
        cells: dict[tuple[str, int], Decimal] = {}
        totals_by_position: dict[int, Decimal] = {}
        for entry in entries:
            item = entry.measurement_item
            if item is None:
                continue
            if item.id not in positions_by_id:
                positions_by_id[item.id] = MatrixPosition(
                    item_id=item.id,
                    position=item.position,
                    description=item.description,
                    unit=item.unit or "",
                    sort_order=item.sort_order,
                )
            area_label = " ".join(entry.area_or_comment.split())
            area_key = area_label.casefold()
            area_by_key.setdefault(area_key, MatrixArea(key=area_key, label=area_label))
            cells[(area_key, item.id)] = cells.get((area_key, item.id), Decimal("0")) + entry.quantity
            totals_by_position[item.id] = totals_by_position.get(item.id, Decimal("0")) + entry.quantity

        return (
            sorted(positions_by_id.values(), key=lambda item: (item.sort_order, item.position)),
            list(area_by_key.values()),
            cells,
            totals_by_position,
        )

    def _render_page(
        self,
        batch: SiteMeasurementBatch,
        positions: list[MatrixPosition],
        areas: list[MatrixArea],
        cells: dict[tuple[str, int], Decimal],
        totals_by_position: dict[int, Decimal],
        page_number: int,
        page_count: int,
        position_page_index: int,
        area_page_index: int,
        logo: PdfImage | None,
    ) -> list[bytes]:
        site = batch.site
        assert site is not None
        commands: list[bytes] = [b"0.75 w"]
        title = _format_batch_number(site.site_number, batch.number)
        submitted_by = _format_user(batch.submitted_by) or "-"
        submitted_at = _format_datetime(batch.submitted_at)
        address = " ".join(part for part in [site.street, site.house_number] if part)
        city = " ".join(part for part in [site.postal_code, site.city] if part)
        project_address = ", ".join(part for part in [address or site.address, city] if part) or "-"
        _template_header(
            commands=commands,
            title=title,
            customer=site.customer or "-",
            project=site.name,
            commission=site.site_number or "-",
            date_label=_format_date(datetime.now()),
            sheet_label=_format_sheet_label(title, page_number, page_count),
            logo=logo,
        )
        _header_meta_row(
            commands,
            address=project_address,
            submitted_by=submitted_by,
            submitted_at=submitted_at or "-",
            status_label=_status_label(batch.status),
        )

        _draw_measurement_matrix(
            commands=commands,
            positions=positions,
            areas=areas,
            cells=cells,
            totals_by_position=totals_by_position,
        )

        if page_number == page_count:
            _draw_grand_total(commands)
            _signature_block(commands, contractor_name=submitted_by)
        else:
            _text(commands, PAGE_WIDTH - MARGIN, 68, "Fortsetzung auf folgendem Blatt", 8, "F2", align_right=True)

        return commands


def _template_header(
    *,
    commands: list[bytes],
    title: str,
    customer: str,
    project: str,
    commission: str,
    date_label: str,
    sheet_label: str,
    logo: PdfImage | None,
) -> None:
    _text(commands, 56, 513, "Aufmaß", 20, "F2")
    _line(commands, 56, 510, 145, 510)
    if logo is not None:
        _image_fit(
            commands,
            LOGO_RESOURCE_NAME,
            x=645,
            top_y=65,
            max_width=120,
            max_height=80,
            image=logo,
        )

    _text(commands, TABLE_LEFT, 481, "Kunde:", 8, "F2")
    _line(commands, 94.7, 478, 360, 478)
    _text(commands, 99, 481, customer, 8)
    _text(commands, 365, 481, "Komissions-Nr.:", 8, "F2")
    _line(commands, 460, 478, 620, 478)
    _text(commands, 465, 481, commission, 8)
    _text(commands, TABLE_LEFT, 451, "Projekt/Bauvorhaben:", 8, "F2")
    _line(commands, 175, 448, 420, 448)
    _text(commands, 180, 451, project, 8)
    _text(commands, 420, 451, "Blatt-Nr.:", 8, "F2")
    _line(commands, 475, 448, 510, 448)
    sheet_label_size = 5.0 if len(sheet_label) > 8 else 7.4
    _text(commands, 477, 451, sheet_label, sheet_label_size, "F2")
    _text(commands, 510, 451, "Datum:", 8, "F2")
    _line(commands, 552, 448, 620, 448)
    _text(commands, 557, 451, date_label, 8)


def _header_meta_row(
    commands: list[bytes],
    *,
    address: str,
    submitted_by: str,
    submitted_at: str,
    status_label: str,
) -> None:
    y = 574.4
    _text_fitted(commands, TABLE_LEFT, y, f"Adresse: {address}", 6.0, max_width=210)
    _text_fitted(commands, 275, y, f"Monteur: {submitted_by}", 6.0, max_width=140)
    _text_fitted(commands, 430, y, f"Eingereicht: {submitted_at}", 6.0, max_width=140)
    _text_fitted(commands, 585, y, f"Status: {status_label}", 6.0, max_width=62)


def _draw_measurement_matrix(
    *,
    commands: list[bytes],
    positions: list[MatrixPosition],
    areas: list[MatrixArea],
    cells: dict[tuple[str, int], Decimal],
    totals_by_position: dict[int, Decimal],
) -> None:
    _draw_matrix_grid(commands)
    _text(
        commands,
        TABLE_LEFT + 4,
        _baseline_between(TABLE_TOP, MATRIX_POSITION_BOTTOM, 12),
        "Pos. Lt. Bestellung:",
        12,
        "F2",
    )
    _text(commands, TABLE_LEFT + 4, MATRIX_DESCRIPTION_BOTTOM + 52, "Art der Leistung:", 12, "F2")
    _text(
        commands,
        TABLE_LEFT + 4,
        _baseline_between(MATRIX_DESCRIPTION_BOTTOM, MATRIX_UNIT_BOTTOM, 12),
        "Einheit:",
        12,
        "F2",
    )
    _text_rotated(commands, 78, 117, "Bauteil / Abschnitt", 12, "F2")

    for index in range(MATRIX_COLUMN_COUNT):
        x = MATRIX_COLUMN_BOUNDARIES[index]
        column_right = MATRIX_COLUMN_BOUNDARIES[index + 1]
        width = column_right - x
        if index >= len(positions):
            continue
        position = positions[index]
        _cell_text(
            commands,
            x,
            _baseline_between(TABLE_TOP, MATRIX_POSITION_BOTTOM, 5.4) + 1.5,
            position.position,
            width,
            5.4,
            "F2",
        )
        _rotated_cell_text(
            commands,
            x,
            MATRIX_DESCRIPTION_BOTTOM,
            width,
            MATRIX_POSITION_BOTTOM - MATRIX_DESCRIPTION_BOTTOM,
            position.description,
        )
        _cell_text(
            commands,
            x,
            _baseline_between(MATRIX_DESCRIPTION_BOTTOM, MATRIX_UNIT_BOTTOM, 6.2) + 2,
            position.unit,
            width,
            6.2,
            "F2",
        )

        for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
            value = cells.get((area.key, position.item_id))
            if value is None:
                continue
            row_top = MATRIX_AREA_ROW_LINES[area_index]
            row_bottom = MATRIX_AREA_ROW_LINES[area_index + 1]
            y = _baseline_between(row_top, row_bottom, 6.2)
            _text_centered(commands, (x + column_right) / 2, y, _format_decimal(value), 6.2)
        total = totals_by_position.get(position.item_id)
        if total is not None:
            _text(
                commands,
                column_right - 2.5,
                _baseline_between(MATRIX_TOTAL_TOP, MATRIX_BOTTOM, 6.2),
                _format_decimal(total),
                6.2,
                "F2",
                align_right=True,
            )

    for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
        row_top = MATRIX_AREA_ROW_LINES[area_index]
        row_bottom = MATRIX_AREA_ROW_LINES[area_index + 1]
        y = _baseline_between(row_top, row_bottom, 6.3)
        _cell_text(commands, MATRIX_AREA_LABEL_X, y + 2, area.label, MATRIX_AREA_LABEL_WIDTH, 6.3)


def _signature_block(commands: list[bytes], *, contractor_name: str) -> None:
    _text(commands, 53, 53.6, "Die Richtigkeit des Aufmaßes und die", 7)
    _text(commands, 53, 42.6, "ordnungsgemäße Montage bescheinigen:", 7)
    _text(commands, 54, 20.0, "Ort / Datum:", 7, "F2")
    _line(commands, 136, 14.6, 233.5, 14.6, 0.8)

    _text(commands, 248.5, 45.4, "Name Auftragnehmer (BEG):", 7, "F2")
    _text_fitted(commands, 396, 45.0, contractor_name, 8, max_width=158)
    _line(commands, 394.9, 41.3, 566.6, 41.3, 0.8)
    _text(commands, 598.6, 44.6, "Unterschrift:", 7, "F2")
    _line(commands, 661, 41.3, 764, 41.3, 0.8)

    _text(commands, 250.2, 20.4, "Name Auftraggeber (Kunde):", 7, "F2")
    _line(commands, 394.9, 14.6, 566.6, 14.6, 0.8)
    _text(commands, 598.6, 19.6, "Unterschrift:", 7, "F2")
    _line(commands, 661, 14.6, 764, 14.6, 0.8)


def _wrapped(value: str, width: int) -> list[str]:
    text = " ".join((value or "").split())
    return wrap(text, width=width, break_long_words=False) or [""]


def _draw_matrix_grid(commands: list[bytes]) -> None:
    for y in (MATRIX_POSITION_BOTTOM, MATRIX_DESCRIPTION_BOTTOM, MATRIX_UNIT_BOTTOM, MATRIX_TOTAL_TOP):
        _line(commands, TABLE_LEFT, y, TABLE_RIGHT, y, 1.0)
    for y in MATRIX_AREA_ROW_LINES[1:-1]:
        _line(commands, MATRIX_SECTION_LABEL_RIGHT, y, TABLE_RIGHT, y, 0.75)

    for x in MATRIX_COLUMN_BOUNDARIES[1:-1]:
        _line(commands, x, MATRIX_BOTTOM, x, TABLE_TOP, 0.75)
    _line(commands, MATRIX_SECTION_LABEL_RIGHT, MATRIX_BOTTOM, MATRIX_UNIT_BOTTOM, 0.85)
    _line(commands, MATRIX_X, MATRIX_BOTTOM, MATRIX_X, TABLE_TOP, 1.35)

    _line(commands, TABLE_LEFT, MATRIX_BOTTOM, TABLE_LEFT, TABLE_TOP, 1.6)
    _line(commands, TABLE_RIGHT, MATRIX_BOTTOM, TABLE_RIGHT, TABLE_TOP, 1.6)
    _line(commands, TABLE_LEFT, TABLE_TOP, TABLE_RIGHT, TABLE_TOP, 1.6)
    _line(commands, TABLE_LEFT, MATRIX_BOTTOM, TABLE_RIGHT, MATRIX_BOTTOM, 1.6)


def _draw_grand_total(commands: list[bytes]) -> None:
    y = _baseline_between(MATRIX_TOTAL_TOP, MATRIX_BOTTOM, 7.2)
    _text(commands, MATRIX_AREA_LABEL_X + 4, y, "Gesamtsumme:", 7.2, "F2")


def _baseline_between(top: float, bottom: float, size: float) -> float:
    return bottom + (top - bottom - size) / 2 + size * 0.22


def _load_png_rgb(path: Path) -> PdfImage | None:
    if not path.exists():
        return None
    try:
        raw = path.read_bytes()
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            return None
        offset = 8
        width = height = color_type = bit_depth = None
        idat_parts: list[bytes] = []
        while offset + 8 <= len(raw):
            length = struct.unpack(">I", raw[offset : offset + 4])[0]
            chunk_type = raw[offset + 4 : offset + 8]
            chunk_data = raw[offset + 8 : offset + 8 + length]
            offset += 12 + length
            if chunk_type == b"IHDR":
                width, height, bit_depth, color_type, _compression, _filter, interlace = (
                    struct.unpack(">IIBBBBB", chunk_data)
                )
                if bit_depth != 8 or color_type not in {2, 6} or interlace != 0:
                    return None
            elif chunk_type == b"IDAT":
                idat_parts.append(chunk_data)
            elif chunk_type == b"IEND":
                break
        if width is None or height is None or color_type is None:
            return None

        channels = 4 if color_type == 6 else 3
        stride = width * channels
        inflated = zlib.decompress(b"".join(idat_parts))
        decoded_rows: list[bytearray] = []
        previous = bytearray(stride)
        cursor = 0
        for _row in range(height):
            filter_type = inflated[cursor]
            cursor += 1
            row = bytearray(inflated[cursor : cursor + stride])
            cursor += stride
            _apply_png_filter(row, previous, channels, filter_type)
            decoded_rows.append(row)
            previous = row

        crop_left, crop_top, crop_right, crop_bottom = 0, 0, width - 1, height - 1
        if color_type == 6:
            crop_left, crop_top, crop_right, crop_bottom = _alpha_crop_box(decoded_rows, width)

        rows: list[bytes] = []
        for row in decoded_rows[crop_top : crop_bottom + 1]:
            if color_type == 6:
                rgb = bytearray()
                for x in range(crop_left, crop_right + 1):
                    index = x * 4
                    alpha = row[index + 3]
                    rgb.extend(
                        (
                            _blend_on_white(row[index], alpha),
                            _blend_on_white(row[index + 1], alpha),
                            _blend_on_white(row[index + 2], alpha),
                        )
                    )
                rows.append(bytes(rgb))
            else:
                rows.append(bytes(row[crop_left * 3 : (crop_right + 1) * 3]))
        crop_width = crop_right - crop_left + 1
        crop_height = crop_bottom - crop_top + 1
        return PdfImage(width=crop_width, height=crop_height, data=zlib.compress(b"".join(rows), 9))
    except Exception:
        return None


def _chunk[T](rows: list[T], size: int) -> list[list[T]]:
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def _format_batch_number(site_number: str | None, number: int) -> str:
    prefix = site_number or "Aufmaß"
    return f"{prefix}.{number:02d}" if site_number else f"Aufmaß {number}"


def _format_sheet_label(title: str, page_number: int, page_count: int) -> str:
    if page_count <= 1:
        return title
    return f"{title}.{page_number:02d}"


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
    size: float,
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
        + _number(size)
        + b" Tf "
        + _number(text_x)
        + b" "
        + _number(y)
        + b" Td "
        + _pdf_string(text)
        + b" Tj ET"
    )


def _text_centered(
    commands: list[bytes],
    center_x: float,
    y: float,
    text: str,
    size: float,
    font: str = "F1",
) -> None:
    text_width = len(text) * size * 0.48
    _text(commands, center_x - text_width / 2, y, text, size, font)


def _text_rotated(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: float,
    font: str = "F1",
) -> None:
    commands.append(
        b"BT /"
        + font.encode("ascii")
        + b" "
        + _number(size)
        + b" Tf 0 1 -1 0 "
        + _number(x)
        + b" "
        + _number(y)
        + b" Tm "
        + _pdf_string(text)
        + b" Tj ET"
    )


def _rotated_cell_text(
    commands: list[bytes],
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
) -> None:
    size = 5.8
    line_height = 6.4
    max_chars = max(16, int((height - 8) / (size * 0.48)))
    lines = _wrap_ellipsis(text, width=max_chars, max_lines=5)
    block_width = (len(lines) - 1) * line_height
    start_x = x + (width - block_width) / 2 + 2
    for index, line in enumerate(lines):
        _text_rotated(commands, start_x + index * line_height, y + 4, line, size)


def _cell_text(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    width: float,
    size: float,
    font: str = "F1",
) -> None:
    lines = _wrapped(text, max(4, int(width / (size * 0.55))))[:2]
    for index, line in enumerate(lines):
        _text(commands, x + 2, y - index * (size + 1.5), line, size, font)


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
    top_y: float,
    max_width: float,
    max_height: float,
    image: PdfImage,
) -> None:
    scale = min(max_width / image.width, max_height / image.height)
    width = image.width * scale
    height = image.height * scale
    fitted_x = x + (max_width - width) / 2
    fitted_y = PAGE_HEIGHT - top_y - height
    _image(commands, name, fitted_x, fitted_y, width, height)


def _trim_text(value: str, max_chars: int) -> str:
    text = " ".join((value or "").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _text_fitted(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: float,
    *,
    max_width: float,
    font: str = "F1",
) -> None:
    _text(commands, x, y, _trim_to_width(text, size=size, max_width=max_width), size, font)


def _trim_to_width(value: str, *, size: float, max_width: float) -> str:
    text = " ".join((value or "").split())
    if len(text) * size * 0.48 <= max_width:
        return text
    max_chars = max(1, int(max_width / (size * 0.48)))
    return _trim_text(text, max_chars)


def _wrap_ellipsis(value: str, *, width: int, max_lines: int) -> list[str]:
    text = " ".join((value or "").split())
    if not text:
        return [""]
    lines = wrap(text, width=width, break_long_words=False)
    if len(lines) <= max_lines:
        return [_trim_text(line, width) for line in lines]
    kept = [_trim_text(line, width) for line in lines[: max_lines - 1]]
    kept.append(_trim_text(" ".join(lines[max_lines - 1 :]), width))
    return kept


def _alpha_crop_box(rows: list[bytearray], width: int) -> tuple[int, int, int, int]:
    crop_left = width
    crop_top = len(rows)
    crop_right = -1
    crop_bottom = -1
    for y, row in enumerate(rows):
        for x in range(width):
            if row[x * 4 + 3] <= 8:
                continue
            crop_left = min(crop_left, x)
            crop_top = min(crop_top, y)
            crop_right = max(crop_right, x)
            crop_bottom = max(crop_bottom, y)
    if crop_right < crop_left or crop_bottom < crop_top:
        return 0, 0, width - 1, len(rows) - 1
    return crop_left, crop_top, crop_right, crop_bottom


def _apply_png_filter(
    row: bytearray,
    previous: bytearray,
    bytes_per_pixel: int,
    filter_type: int,
) -> None:
    for index, value in enumerate(row):
        left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
        up = previous[index]
        upper_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
        if filter_type == 0:
            predictor = 0
        elif filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        elif filter_type == 4:
            predictor = _paeth(left, up, upper_left)
        else:
            raise ValueError(f"Unsupported PNG filter: {filter_type}")
        row[index] = (value + predictor) & 0xFF


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    distance_left = abs(estimate - left)
    distance_up = abs(estimate - up)
    distance_upper_left = abs(estimate - upper_left)
    if distance_left <= distance_up and distance_left <= distance_upper_left:
        return left
    if distance_up <= distance_upper_left:
        return up
    return upper_left


def _blend_on_white(channel: int, alpha: int) -> int:
    return (channel * alpha + 255 * (255 - alpha)) // 255


def _line(
    commands: list[bytes],
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    width: float | None = None,
) -> None:
    line = b" ".join([_number(x1), _number(y1), b"m", _number(x2), _number(y2), b"l S"])
    if width is None:
        commands.append(line)
        return
    commands.append(b"q " + _number(width) + b" w " + line + b" Q")


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
