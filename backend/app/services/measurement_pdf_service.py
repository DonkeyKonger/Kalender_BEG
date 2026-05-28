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
TEMPLATE_LABEL_X = 54
TEMPLATE_VALUE_X = 96
MATRIX_X = 273
MATRIX_TOP = 419
MATRIX_POSITION_BOTTOM = 398
MATRIX_DESCRIPTION_BOTTOM = 278
MATRIX_UNIT_BOTTOM = 257
MATRIX_BOTTOM = 91
MATRIX_COLUMN_WIDTH = 41
MATRIX_COLUMN_COUNT = 12
MATRIX_AREA_ROW_HEIGHT = 14
MATRIX_AREA_ROW_COUNT = 11
MATRIX_AREA_LABEL_X = 96
MATRIX_AREA_LABEL_WIDTH = 136
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
                        logo_available=logo is not None,
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
        logo_available: bool,
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
        page_suffix = ""
        if page_count > 1:
            page_suffix = f" · Spalte {position_page_index}, Bereich {area_page_index}"

        _template_header(
            commands=commands,
            title=title,
            customer=site.customer or "-",
            project=site.name,
            commission=site.site_number or "-",
            date_label=_format_date(datetime.now()),
            sheet_label=f"{page_number}/{page_count}{page_suffix}",
            logo_available=logo_available,
        )
        _text(commands, 54, 431, f"Adresse: {project_address}", 7)
        _text(commands, 371, 431, f"Monteur: {submitted_by}", 7)
        _text(commands, 522, 431, f"Eingereicht: {submitted_at or '-'}", 7)
        _text(commands, 650, 431, f"Status: {_status_label(batch.status)}", 7)

        _draw_measurement_matrix(
            commands=commands,
            positions=positions,
            areas=areas,
            cells=cells,
            totals_by_position=totals_by_position,
        )

        if page_number == page_count:
            total = sum((entry.quantity for entry in batch.entries), Decimal("0"))
            _text(commands, 98, 77, "Gesamtsumme:", 8, "F2")
            _line(commands, 176, 75, 250, 75)
            _text(commands, 245, 77, _format_decimal(total), 8, "F2", align_right=True)
            _signature_block(commands)
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
    logo_available: bool,
) -> None:
    _text(commands, 56, 513, "Aufmaß", 20, "F2")
    _line(commands, 56, 510, 145, 510)
    if logo_available:
        _image(commands, LOGO_RESOURCE_NAME, 728, 511, 72, 72)
    _text(commands, 650, 500, f"Aufmaß-Nr.: {title}", 10, "F2")
    _text(commands, TEMPLATE_LABEL_X, 481, "Kunde:", 8, "F2")
    _line(commands, 95, 478, 370, 478)
    _text(commands, 100, 481, customer, 8)
    _text(commands, 371, 481, "Komissions-Nr.:", 8, "F2")
    _line(commands, 464, 478, 805, 478)
    _text(commands, 470, 481, commission, 8)
    _text(commands, 53, 451, "Projekt/Bauvorhaben:", 8, "F2")
    _line(commands, 178, 448, 428, 448)
    _text(commands, 184, 451, project, 8)
    _text(commands, 428, 451, "Blatt-Nr.:", 8, "F2")
    _line(commands, 480, 448, 520, 448)
    _text(commands, 484, 451, sheet_label, 7)
    _text(commands, 522, 451, "Datum:", 8, "F2")
    _line(commands, 564, 448, 805, 448)
    _text(commands, 570, 451, date_label, 8)


def _draw_measurement_matrix(
    *,
    commands: list[bytes],
    positions: list[MatrixPosition],
    areas: list[MatrixArea],
    cells: dict[tuple[str, int], Decimal],
    totals_by_position: dict[int, Decimal],
) -> None:
    matrix_right = MATRIX_X + MATRIX_COLUMN_COUNT * MATRIX_COLUMN_WIDTH
    _text(commands, TEMPLATE_LABEL_X, 401, "Pos. Lt. Bestellung:", 9, "F2")
    _line(commands, 52, MATRIX_POSITION_BOTTOM, 232, MATRIX_POSITION_BOTTOM)
    _text(commands, TEMPLATE_LABEL_X, 331, "Art der Leistung:", 9, "F2")
    _line(commands, 52, MATRIX_DESCRIPTION_BOTTOM, 232, MATRIX_DESCRIPTION_BOTTOM)
    _text(commands, TEMPLATE_LABEL_X, 261, "Einheit:", 9, "F2")
    _text_rotated(commands, 80, 104, "Bauteil / Abschnitt", 10, "F2")

    for x in [MATRIX_X + index * MATRIX_COLUMN_WIDTH for index in range(MATRIX_COLUMN_COUNT + 1)]:
        _line(commands, x, MATRIX_BOTTOM, x, MATRIX_TOP)
    for y in [MATRIX_TOP, MATRIX_POSITION_BOTTOM, MATRIX_DESCRIPTION_BOTTOM, MATRIX_UNIT_BOTTOM, MATRIX_BOTTOM]:
        _line(commands, MATRIX_X, y, matrix_right, y)

    for row_index in range(MATRIX_AREA_ROW_COUNT + 1):
        y = MATRIX_UNIT_BOTTOM - row_index * MATRIX_AREA_ROW_HEIGHT
        _line(commands, MATRIX_AREA_LABEL_X, y, matrix_right, y)
    _line(commands, MATRIX_AREA_LABEL_X, MATRIX_BOTTOM, matrix_right, MATRIX_BOTTOM)
    _line(commands, MATRIX_AREA_LABEL_X, MATRIX_BOTTOM, MATRIX_AREA_LABEL_X, MATRIX_UNIT_BOTTOM)
    _line(
        commands,
        MATRIX_AREA_LABEL_X + MATRIX_AREA_LABEL_WIDTH,
        MATRIX_BOTTOM,
        MATRIX_AREA_LABEL_X + MATRIX_AREA_LABEL_WIDTH,
        MATRIX_UNIT_BOTTOM,
    )

    for index in range(MATRIX_COLUMN_COUNT):
        x = MATRIX_X + index * MATRIX_COLUMN_WIDTH
        if index >= len(positions):
            continue
        position = positions[index]
        _cell_text(commands, x, MATRIX_POSITION_BOTTOM + 5, position.position, MATRIX_COLUMN_WIDTH, 5.5, "F2")
        _rotated_cell_text(
            commands,
            x,
            MATRIX_DESCRIPTION_BOTTOM,
            MATRIX_COLUMN_WIDTH,
            MATRIX_POSITION_BOTTOM - MATRIX_DESCRIPTION_BOTTOM,
            position.description,
        )
        _cell_text(commands, x, MATRIX_UNIT_BOTTOM + 7, position.unit, MATRIX_COLUMN_WIDTH, 6, "F2")

        for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
            value = cells.get((area.key, position.item_id))
            if value is None:
                continue
            y = MATRIX_UNIT_BOTTOM - area_index * MATRIX_AREA_ROW_HEIGHT - 10
            _text(commands, x + MATRIX_COLUMN_WIDTH - 3, y, _format_decimal(value), 6, "F1", align_right=True)
        total = totals_by_position.get(position.item_id)
        if total is not None:
            _text(commands, x + MATRIX_COLUMN_WIDTH - 3, 77, _format_decimal(total), 6, "F2", align_right=True)

    for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
        y = MATRIX_UNIT_BOTTOM - area_index * MATRIX_AREA_ROW_HEIGHT - 10
        _text(commands, MATRIX_AREA_LABEL_X + 4, y, area.label, 6.5)


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


def _wrapped(value: str, width: int) -> list[str]:
    text = " ".join((value or "").split())
    return wrap(text, width=width, break_long_words=False) or [""]


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
        rows: list[bytes] = []
        previous = bytearray(stride)
        cursor = 0
        for _row in range(height):
            filter_type = inflated[cursor]
            cursor += 1
            row = bytearray(inflated[cursor : cursor + stride])
            cursor += stride
            _apply_png_filter(row, previous, channels, filter_type)
            if color_type == 6:
                rgb = bytearray()
                for index in range(0, len(row), 4):
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
                rows.append(bytes(row))
            previous = row
        return PdfImage(width=width, height=height, data=zlib.compress(b"".join(rows), 9))
    except Exception:
        return None


def _chunk[T](rows: list[T], size: int) -> list[list[T]]:
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


def _text_rotated(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: int,
    font: str = "F1",
) -> None:
    commands.append(
        b"BT /"
        + font.encode("ascii")
        + b" "
        + str(size).encode("ascii")
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
    size = 6
    max_chars = max(16, int((height - 10) / (size * 0.48)))
    _text_rotated(
        commands,
        x + width * 0.58,
        y + 5,
        _trim_text(text, max_chars),
        size,
    )


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
        _text(commands, x + 2, y - index * (size + 1.5), line, int(size), font)


def _image(commands: list[bytes], name: str, x: float, y: float, width: float, height: float) -> None:
    commands.append(
        b"q "
        + b" ".join([_number(width), b"0", b"0", _number(height), _number(x), _number(y)])
        + b" cm /"
        + name.encode("ascii")
        + b" Do Q"
    )


def _trim_text(value: str, max_chars: int) -> str:
    text = " ".join((value or "").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


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
