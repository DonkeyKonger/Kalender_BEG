from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
import logging
from math import ceil
from pathlib import Path
from typing import Iterable
from time import perf_counter
from zoneinfo import ZoneInfo

from PIL import Image, ImageOps, UnidentifiedImageError
from reportlab import rl_config
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

from app.services.photo_limits import MAX_PHOTO_DIMENSION, PHOTO_JPEG_QUALITY


PAGE_WIDTH, PAGE_HEIGHT = A4
PAGE_MARGIN = 34.0
CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN
CONTENT_BOTTOM = 58.0
FIRST_PAGE_CONTENT_TOP = 626.0
FOLLOWING_PAGE_CONTENT_TOP = 748.0
INFORMATION_BLOCK_TOP = 707.0
INFORMATION_BLOCK_MIN_HEIGHT = 58.0
INFORMATION_BLOCK_CONTENT_GAP = 23.0
COMPACT_LOGO_SCALE_FACTOR = 1.2
COMPACT_LOGO_MAX_WIDTH = 56.0 * COMPACT_LOGO_SCALE_FACTOR
COMPACT_LOGO_MAX_HEIGHT = 40.0 * COMPACT_LOGO_SCALE_FACTOR
PDF_IMAGE_DPI = 160
PDF_POINTS_PER_INCH = 72
LOGO_PATH = Path(__file__).resolve().parents[1] / "assets" / "beg_logo_full.png"

BEG_BLUE = HexColor("#142A52")
BEG_MUTED_BLUE = HexColor("#61718B")
BEG_PALE_BLUE = HexColor("#F0F4F9")
BEG_LINE = HexColor("#CBD5E1")
BEG_YELLOW = HexColor("#FFD11A")
TEXT_DARK = HexColor("#172033")
TEXT_MUTED = HexColor("#65738A")
DOCUMENT_TIMEZONE = ZoneInfo("Europe/Berlin")
LOGGER = logging.getLogger(__name__)

# JPEG streams are already compressed. ASCII85 only wraps those binary bytes,
# adding CPU and about 25% size without changing image quality or compatibility.
rl_config.useA85 = 0


@dataclass(frozen=True)
class PhotoAppendixContext:
    document_type: str
    site_name: str
    generated_at: datetime
    site_number: str | None = None
    site_address: str | None = None
    process_title: str | None = None
    document_number_label: str | None = None
    document_number: str | None = None
    uploaded_at: datetime | None = None
    monteur: str | None = None


@dataclass(frozen=True)
class PhotoAppendixPhoto:
    filename: str
    content: bytes
    caption: str | None = None
    uploaded_at: datetime | None = None
    monteur: str | None = None


@dataclass(frozen=True)
class PreparedPhoto:
    source: PhotoAppendixPhoto
    image_data: bytes | None
    width: int
    height: int
    caption_lines: tuple[str, ...]
    filename_lines: tuple[str, ...]
    metadata_height: float
    desired_image_height: float
    error: str | None = None

    @property
    def aspect_ratio(self) -> float:
        return self.width / self.height if self.width > 0 and self.height > 0 else 1.5

    @property
    def fixed_height(self) -> float:
        caption_height = 0.0
        if self.caption_lines:
            caption_height = 15.0 + len(self.caption_lines) * 12.0 + 10.0
        return 27.0 + caption_height + 10.0 + self.metadata_height + 16.0


@dataclass(frozen=True)
class PlacedPhoto:
    photo: PreparedPhoto
    image_height: float

    @property
    def height(self) -> float:
        return self.photo.fixed_height + self.image_height


@dataclass(frozen=True)
class InformationBlockLine:
    text: str
    bold: bool


@dataclass(frozen=True)
class InformationBlockColumn:
    label: str
    lines: tuple[InformationBlockLine, ...]


@dataclass(frozen=True)
class InformationBlockLayout:
    columns: tuple[InformationBlockColumn, ...]
    height: float

    @property
    def bottom(self) -> float:
        return INFORMATION_BLOCK_TOP - self.height

    @property
    def content_top(self) -> float:
        return self.bottom - INFORMATION_BLOCK_CONTENT_GAP


class PhotoAppendixPdfService:
    """Build the one shared, portrait A4 photo appendix used by all document contexts."""

    def build(
        self,
        *,
        context: PhotoAppendixContext,
        photos: Iterable[PhotoAppendixPhoto],
    ) -> bytes:
        started_at = perf_counter()
        image_processing_started_at = perf_counter()
        prepared = tuple(_prepare_photo(photo) for photo in photos)
        image_processing_ms = (perf_counter() - image_processing_started_at) * 1000
        if not prepared:
            return b""
        rendering_started_at = perf_counter()
        information_block = _prepare_information_block(context)
        first_page_content_top = (
            information_block.content_top if information_block.columns else FIRST_PAGE_CONTENT_TOP
        )
        pages = _plan_pages(prepared, first_page_content_top=first_page_content_top)
        output = BytesIO()
        pdf = Canvas(output, pagesize=A4, pageCompression=1, invariant=1)
        logo = ImageReader(str(LOGO_PATH)) if LOGO_PATH.exists() else None
        for page_number, page in enumerate(pages, start=1):
            if page_number == 1:
                _draw_full_header(
                    pdf,
                    context,
                    logo,
                    page_number,
                    len(pages),
                    information_block,
                )
                cursor_y = first_page_content_top
            else:
                _draw_compact_header(pdf, context, logo, page_number, len(pages))
                cursor_y = FOLLOWING_PAGE_CONTENT_TOP
            for placed in page:
                cursor_y = _draw_photo_block(
                    pdf,
                    placed,
                    top_y=cursor_y,
                    index=_photo_index(prepared, placed.photo),
                    total=len(prepared),
                )
            _draw_footer(pdf, page_number, len(pages))
            pdf.showPage()
        pdf.save()
        content = output.getvalue()
        LOGGER.info(
            "Photo appendix PDF generated: photos=%s pages=%s source_bytes=%s work_bytes=%s "
            "pdf_bytes=%s image_processing_ms=%.1f rendering_ms=%.1f total_ms=%.1f",
            len(prepared),
            len(pages),
            sum(len(photo.source.content) for photo in prepared),
            sum(len(photo.image_data or b"") for photo in prepared),
            len(content),
            image_processing_ms,
            (perf_counter() - rendering_started_at) * 1000,
            (perf_counter() - started_at) * 1000,
        )
        return content


def normalize_photo_caption(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def format_photo_appendix_site_address(site: object) -> str | None:
    street = " ".join(
        value.strip()
        for value in (getattr(site, "street", None), getattr(site, "house_number", None))
        if isinstance(value, str) and value.strip()
    )
    city = " ".join(
        value.strip()
        for value in (getattr(site, "postal_code", None), getattr(site, "city", None))
        if isinstance(value, str) and value.strip()
    )
    structured = ", ".join(value for value in (street, city) if value)
    if structured:
        return structured
    for attribute in ("address", "location"):
        value = getattr(site, attribute, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _prepare_photo(photo: PhotoAppendixPhoto) -> PreparedPhoto:
    caption = normalize_photo_caption(photo.caption)
    caption_lines = tuple(_wrap_text(caption or "", CONTENT_WIDTH - 20, "Helvetica-Bold", 9.5))
    filename_lines = tuple(
        _wrap_text(photo.filename.strip() or "Unbenanntes Foto", 250, "Helvetica", 7.2)
    )
    value_line_count = max(len(filename_lines), 2 if photo.uploaded_at else 1, 2 if photo.monteur else 1)
    metadata_height = 16.0 + value_line_count * 9.0
    try:
        with Image.open(BytesIO(photo.content)) as source:
            source_format = (source.format or "").upper()
            image = ImageOps.exif_transpose(source)
            aspect_ratio = image.width / image.height if image.height else 1.0
            max_pdf_height = 410.0 if aspect_ratio < 1 else 390.0
            image.thumbnail(
                _pdf_image_target_size(max_pdf_height),
                Image.Resampling.LANCZOS,
            )
            width, height = image.size
            image_output = BytesIO()
            if source_format == "PNG":
                image.save(image_output, format="PNG", optimize=True)
            else:
                _flatten_to_rgb(image).save(
                    image_output,
                    format="JPEG",
                    quality=PHOTO_JPEG_QUALITY,
                    optimize=True,
                )
    except (OSError, UnidentifiedImageError, ValueError):
        return PreparedPhoto(
            source=photo,
            image_data=None,
            width=3,
            height=2,
            caption_lines=caption_lines,
            filename_lines=filename_lines,
            metadata_height=metadata_height,
            desired_image_height=120.0,
            error="Foto konnte nicht dargestellt werden.",
        )
    aspect_ratio = width / height if height else 1.0
    natural_height = CONTENT_WIDTH / aspect_ratio
    max_height = 410.0 if aspect_ratio < 1 else 390.0
    return PreparedPhoto(
        source=photo,
        image_data=image_output.getvalue(),
        width=width,
        height=height,
        caption_lines=caption_lines,
        filename_lines=filename_lines,
        metadata_height=metadata_height,
        desired_image_height=min(natural_height, max_height),
    )


def _pdf_image_target_size(max_pdf_height: float) -> tuple[int, int]:
    width = ceil(CONTENT_WIDTH / PDF_POINTS_PER_INCH * PDF_IMAGE_DPI)
    height = ceil(max_pdf_height / PDF_POINTS_PER_INCH * PDF_IMAGE_DPI)
    return min(MAX_PHOTO_DIMENSION, width), min(MAX_PHOTO_DIMENSION, height)


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        flattened = Image.new("RGB", rgba.size, "white")
        flattened.paste(rgba, mask=rgba.getchannel("A"))
        return flattened
    return image.convert("RGB")


def _plan_pages(
    photos: tuple[PreparedPhoto, ...],
    *,
    first_page_content_top: float = FIRST_PAGE_CONTENT_TOP,
) -> tuple[tuple[PlacedPhoto, ...], ...]:
    pages: list[list[PlacedPhoto]] = [[]]
    remaining = first_page_content_top - CONTENT_BOTTOM
    for photo in photos:
        desired_total = photo.fixed_height + photo.desired_image_height
        if pages[-1] and desired_total > remaining:
            pages.append([])
            remaining = FOLLOWING_PAGE_CONTENT_TOP - CONTENT_BOTTOM
        available_image_height = max(80.0, remaining - photo.fixed_height)
        image_height = min(photo.desired_image_height, available_image_height)
        placed = PlacedPhoto(photo=photo, image_height=image_height)
        pages[-1].append(placed)
        remaining -= placed.height
    return tuple(tuple(page) for page in pages)


def _draw_full_header(
    pdf: Canvas,
    context: PhotoAppendixContext,
    logo: ImageReader | None,
    page_number: int,
    page_count: int,
    information_block: InformationBlockLayout,
) -> None:
    _draw_logo_contained(pdf, logo, x=PAGE_MARGIN, y=735, max_width=105, max_height=72)
    pdf.setFillColor(BEG_BLUE)
    pdf.setFont("Helvetica-Bold", 25)
    pdf.drawString(154, 788, "Fotoanlage")
    pdf.setFont("Helvetica", 14)
    pdf.drawString(154, 765, _clean(context.document_type))

    right_x = 392.0
    value_x = 478.0
    _draw_header_value(pdf, right_x, value_x, 793, "Erstellt am:", _format_datetime(context.generated_at))
    if _clean(context.document_number_label) and _clean(context.document_number):
        _draw_header_value(
            pdf,
            right_x,
            value_x,
            774,
            f"{_clean(context.document_number_label)}:",
            _clean(context.document_number),
        )
    _draw_header_value(pdf, right_x, value_x, 755, "Seite:", f"{page_number} von {page_count}")

    pdf.setStrokeColor(BEG_BLUE)
    pdf.setLineWidth(1.2)
    pdf.line(PAGE_MARGIN, 723, PAGE_WIDTH - PAGE_MARGIN, 723)
    _draw_information_block(pdf, information_block)


def _draw_compact_header(
    pdf: Canvas,
    context: PhotoAppendixContext,
    logo: ImageReader | None,
    page_number: int,
    page_count: int,
) -> None:
    _draw_logo_contained(
        pdf,
        logo,
        x=PAGE_MARGIN,
        y=772,
        max_width=COMPACT_LOGO_MAX_WIDTH,
        max_height=COMPACT_LOGO_MAX_HEIGHT,
    )
    pdf.setFillColor(BEG_BLUE)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(101, 801, f"Fotoanlage - {_clean(context.document_type)}")
    pdf.setFillColor(TEXT_MUTED)
    pdf.setFont("Helvetica", 8)
    context_line = _clean(context.site_name)
    if _clean(context.document_number):
        context_line = f"{context_line} · {_clean(context.document_number)}"
    pdf.drawString(101, 785, context_line)
    pdf.drawRightString(PAGE_WIDTH - PAGE_MARGIN, 793, f"Seite {page_number} von {page_count}")
    pdf.setStrokeColor(BEG_BLUE)
    pdf.setLineWidth(0.8)
    pdf.line(PAGE_MARGIN, 770, PAGE_WIDTH - PAGE_MARGIN, 770)


def _prepare_information_block(context: PhotoAppendixContext) -> InformationBlockLayout:
    items: list[tuple[str, tuple[tuple[str, bool], ...]]] = []
    site_values = tuple(
        (value, index == 0)
        for index, value in enumerate(
            (
                _clean(context.site_name),
                _clean(context.site_number),
                _clean(context.site_address),
            )
        )
        if value
    )
    if site_values:
        items.append(("Baustelle", site_values))

    process_values = tuple(
        (value, index == 0)
        for index, value in enumerate(
            (_clean(context.process_title), _clean(context.document_number))
        )
        if value
    )
    if process_values:
        items.append(("Vorgang", process_values))
    if _clean(context.monteur):
        items.append(("Monteur", ((_clean(context.monteur), True),)))
    if not items:
        return InformationBlockLayout(columns=(), height=0.0)

    column_width = CONTENT_WIDTH / len(items)
    text_width = column_width - 22
    columns: list[InformationBlockColumn] = []
    for label, values in items:
        lines: list[InformationBlockLine] = []
        for value, bold in values:
            font = "Helvetica-Bold" if bold else "Helvetica"
            lines.extend(
                InformationBlockLine(text=line, bold=bold)
                for line in _wrap_text(value, text_width, font, 7.4)
            )
        columns.append(InformationBlockColumn(label=label, lines=tuple(lines)))

    maximum_line_count = max(len(column.lines) for column in columns)
    height = max(INFORMATION_BLOCK_MIN_HEIGHT, 28.0 + maximum_line_count * 10.0)
    return InformationBlockLayout(columns=tuple(columns), height=height)


def _draw_information_block(pdf: Canvas, layout: InformationBlockLayout) -> None:
    if not layout.columns:
        return

    x = PAGE_MARGIN
    y = layout.bottom
    height = layout.height
    pdf.setFillColor(BEG_PALE_BLUE)
    pdf.roundRect(x, y, CONTENT_WIDTH, height, 4, stroke=0, fill=1)
    column_width = CONTENT_WIDTH / len(layout.columns)
    for index, column in enumerate(layout.columns):
        column_x = x + index * column_width + 12
        if index:
            pdf.setStrokeColor(BEG_LINE)
            pdf.setLineWidth(0.5)
            pdf.line(x + index * column_width, y + 9, x + index * column_width, y + height - 9)
        pdf.setFillColor(TEXT_MUTED)
        pdf.setFont("Helvetica", 7)
        pdf.drawString(column_x, INFORMATION_BLOCK_TOP - 17, column.label)
        pdf.setFillColor(TEXT_DARK)
        for line_index, line in enumerate(column.lines):
            pdf.setFont("Helvetica-Bold" if line.bold else "Helvetica", 7.4)
            pdf.drawString(column_x, INFORMATION_BLOCK_TOP - 30 - line_index * 10, line.text)


def _draw_photo_block(
    pdf: Canvas,
    placed: PlacedPhoto,
    *,
    top_y: float,
    index: int,
    total: int,
) -> float:
    photo = placed.photo
    badge_size = 20.0
    pdf.setFillColor(BEG_BLUE)
    pdf.roundRect(PAGE_MARGIN, top_y - badge_size, badge_size, badge_size, 2, stroke=0, fill=1)
    pdf.setFillColor(BEG_YELLOW)
    pdf.rect(PAGE_MARGIN, top_y - badge_size, 2.5, badge_size, stroke=0, fill=1)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawCentredString(PAGE_MARGIN + badge_size / 2, top_y - 14, str(index))
    pdf.setFillColor(BEG_BLUE)
    pdf.setFont("Helvetica-Bold", 11)
    pdf.drawString(PAGE_MARGIN + 31, top_y - 14, f"Foto {index} von {total}")
    cursor_y = top_y - 27

    if photo.caption_lines:
        pdf.setFillColor(TEXT_MUTED)
        pdf.setFont("Helvetica", 7)
        pdf.drawString(PAGE_MARGIN, cursor_y - 7, "Beschriftung")
        box_height = len(photo.caption_lines) * 12 + 10
        box_top = cursor_y - 14
        pdf.setFillColor(BEG_PALE_BLUE)
        pdf.roundRect(PAGE_MARGIN, box_top - box_height, CONTENT_WIDTH, box_height, 3, stroke=0, fill=1)
        pdf.setFillColor(TEXT_DARK)
        pdf.setFont("Helvetica-Bold", 9.5)
        for line_index, line in enumerate(photo.caption_lines):
            pdf.drawString(PAGE_MARGIN + 9, box_top - 15 - line_index * 12, line)
        cursor_y = box_top - box_height - 10

    image_height = placed.image_height
    if photo.image_data is None:
        pdf.setFillColor(BEG_PALE_BLUE)
        pdf.roundRect(PAGE_MARGIN, cursor_y - image_height, CONTENT_WIDTH, image_height, 4, stroke=0, fill=1)
        pdf.setFillColor(TEXT_MUTED)
        pdf.setFont("Helvetica", 9)
        pdf.drawCentredString(PAGE_WIDTH / 2, cursor_y - image_height / 2, photo.error or "Foto nicht verfügbar.")
    else:
        image_width = min(CONTENT_WIDTH, image_height * photo.aspect_ratio)
        image_x = PAGE_MARGIN + (CONTENT_WIDTH - image_width) / 2
        pdf.drawImage(
            ImageReader(BytesIO(photo.image_data)),
            image_x,
            cursor_y - image_height,
            width=image_width,
            height=image_height,
            preserveAspectRatio=True,
            anchor="c",
            mask="auto",
        )
    cursor_y -= image_height + 10
    cursor_y = _draw_photo_metadata(pdf, photo, top_y=cursor_y)
    pdf.setStrokeColor(BEG_LINE)
    pdf.setLineWidth(0.5)
    pdf.line(PAGE_MARGIN, cursor_y - 7, PAGE_WIDTH - PAGE_MARGIN, cursor_y - 7)
    return cursor_y - 16


def _draw_photo_metadata(pdf: Canvas, photo: PreparedPhoto, *, top_y: float) -> float:
    columns = (
        (PAGE_MARGIN, 260.0, "Dateiname", photo.filename_lines),
        (PAGE_MARGIN + 275, 112.0, "Hochgeladen am", (_format_datetime(photo.source.uploaded_at),) if photo.source.uploaded_at else ()),
        (PAGE_MARGIN + 405, 122.0, "Monteur", (_clean(photo.source.monteur),) if _clean(photo.source.monteur) else ()),
    )
    for x, width, label, values in columns:
        if not values:
            continue
        pdf.setFillColor(TEXT_MUTED)
        pdf.setFont("Helvetica", 6.6)
        pdf.drawString(x, top_y - 7, label)
        pdf.setFillColor(TEXT_DARK)
        pdf.setFont("Helvetica", 7.2)
        for index, value in enumerate(values):
            pdf.drawString(x, top_y - 18 - index * 9, _fit_text(value, width, "Helvetica", 7.2))
    return top_y - photo.metadata_height


def _draw_footer(pdf: Canvas, page_number: int, page_count: int) -> None:
    pdf.setStrokeColor(BEG_BLUE)
    pdf.setLineWidth(0.6)
    pdf.line(PAGE_MARGIN, 41, PAGE_WIDTH - PAGE_MARGIN, 41)
    pdf.setFillColor(BEG_BLUE)
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.drawString(PAGE_MARGIN, 24, "BEG - Abrechnungsdokumentation")
    pdf.drawRightString(PAGE_WIDTH - PAGE_MARGIN, 24, f"Seite {page_number} von {page_count}")


def _draw_logo_contained(
    pdf: Canvas,
    logo: ImageReader | None,
    *,
    x: float,
    y: float,
    max_width: float,
    max_height: float,
) -> None:
    if logo is None:
        return
    width, height = logo.getSize()
    scale = min(max_width / width, max_height / height)
    draw_width = width * scale
    draw_height = height * scale
    pdf.drawImage(
        logo,
        x + (max_width - draw_width) / 2,
        y + (max_height - draw_height) / 2,
        width=draw_width,
        height=draw_height,
        preserveAspectRatio=True,
        mask="auto",
    )


def _draw_header_value(
    pdf: Canvas,
    label_x: float,
    value_x: float,
    y: float,
    label: str,
    value: str,
) -> None:
    pdf.setFillColor(TEXT_MUTED)
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(label_x, y, label)
    pdf.setFillColor(BEG_BLUE)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(value_x, y, _fit_text(value, PAGE_WIDTH - PAGE_MARGIN - value_x, "Helvetica", 8))


def _photo_index(photos: tuple[PreparedPhoto, ...], target: PreparedPhoto) -> int:
    return next(index for index, photo in enumerate(photos, start=1) if photo is target)


def _format_datetime(value: datetime | None) -> str:
    if value is None:
        return ""
    localized = value.astimezone(DOCUMENT_TIMEZONE) if value.tzinfo else value
    return localized.strftime("%d.%m.%Y, %H:%M")


def _clean(value: str | None) -> str:
    return " ".join((value or "").split())


def _fit_text(text: str, max_width: float, font: str, size: float) -> str:
    value = _clean(text)
    if stringWidth(value, font, size) <= max_width:
        return value
    suffix = "…"
    while value and stringWidth(value + suffix, font, size) > max_width:
        value = value[:-1]
    return value.rstrip() + suffix if value else suffix


def _wrap_text(text: str, max_width: float, font: str, size: float) -> list[str]:
    lines: list[str] = []
    for paragraph in (text or "").splitlines() or [""]:
        words = paragraph.split()
        if not words:
            continue
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if stringWidth(candidate, font, size) <= max_width:
                current = candidate
                continue
            lines.extend(_split_oversized_word(current, max_width, font, size))
            current = word
        lines.extend(_split_oversized_word(current, max_width, font, size))
    return lines


def _split_oversized_word(word: str, max_width: float, font: str, size: float) -> list[str]:
    if stringWidth(word, font, size) <= max_width:
        return [word]
    chunks: list[str] = []
    current = ""
    for character in word:
        if current and stringWidth(current + character, font, size) > max_width:
            chunks.append(current)
            current = character
        else:
            current += character
    if current:
        chunks.append(current)
    return chunks
