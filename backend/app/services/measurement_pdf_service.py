from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from io import BytesIO
import logging
from pathlib import Path
import re
import struct
from time import perf_counter
from textwrap import wrap
import zlib

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.project_folder import ProjectFolder
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementBatchPhoto,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.services.document_pdf_cache import DocumentPdfCache, build_pdf_version_hash
from app.services.measurement_service import MEASUREMENT_PHOTO_FOLDER_KEY
from app.services.photo_limits import MAX_PHOTO_DIMENSION, PHOTO_JPEG_QUALITY
from app.services.project_storage_service import ProjectStorageService


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
MATRIX_AREA_LABEL_X = 96.3
MATRIX_AREA_LABEL_WIDTH = MATRIX_X - MATRIX_AREA_LABEL_X
MATRIX_SECTION_LABEL_RIGHT = 96.3
LOGO_RESOURCE_NAME = "ImLogo"
LOGO_PATH = Path(__file__).resolve().parents[1] / "assets" / "beg_logo_icon.png"
PHOTO_MAX_IMAGE_EDGE = MAX_PHOTO_DIMENSION
MEASUREMENT_PDF_CACHE_VERSION = "measurement-pdf-photo-cache-v1"
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class MatrixPosition:
    item_id: int
    position: str
    description: str
    unit: str
    sort_order: int
    is_added: bool = False


@dataclass(frozen=True)
class MatrixArea:
    key: str
    label: str
    is_added: bool = False


@dataclass(frozen=True)
class MatrixCellValue:
    quantity: Decimal
    original_quantity: Decimal | None = None
    is_added: bool = False
    is_removed: bool = False

    @property
    def is_corrected(self) -> bool:
        return (
            self.original_quantity is not None
            and self.original_quantity != self.quantity
            and not self.is_removed
        )


@dataclass(frozen=True)
class SnapshotMatrix:
    positions_by_id: dict[int, MatrixPosition]
    areas_by_key: dict[str, MatrixArea]
    quantities: dict[tuple[str, int], Decimal]


@dataclass(frozen=True)
class PdfImage:
    width: int
    height: int
    data: bytes
    filter_name: str = "FlateDecode"


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
                + b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /"
                + image.filter_name.encode("ascii")
                + b" /Length "
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

    def build_batch_pdf(
        self,
        *,
        site_id: int,
        batch_id: int,
        mode: str = "checked",
    ) -> tuple[bytes, str]:
        if mode not in {"checked", "original"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger PDF-Modus.")
        started_at = perf_counter()
        batch = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.site),
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.area_rows),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.photos).selectinload(
                    SiteMeasurementBatchPhoto.uploaded_by
                ).selectinload(User.person),
            )
            .where(SiteMeasurementBatch.id == batch_id, SiteMeasurementBatch.site_id == site_id)
        )
        if batch is None or batch.site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        file_number = _format_batch_number(batch.site.site_number, batch.number)
        safe_number = file_number.replace("/", "-").replace(" ", "_")
        prefix = "Aufmass_geprueft" if mode == "checked" else "Aufmass"
        filename = f"{prefix}_{safe_number}.pdf"
        version_hash = self._build_batch_pdf_version_hash(batch, mode=mode)
        content, cache_hit = DocumentPdfCache().get_or_build(
            cache_key=f"measurement-{batch.id}-{mode}",
            version_hash=version_hash,
            build=lambda: self._render_batch_pdf_content(batch=batch, mode=mode),
        )
        LOGGER.info(
            "Measurement PDF served: batch_id=%s mode=%s photos=%s cache_hit=%s bytes=%s duration_ms=%.1f",
            batch.id,
            mode,
            len(batch.photos or []),
            cache_hit,
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content, filename

    def _render_batch_pdf_content(self, *, batch: SiteMeasurementBatch, mode: str) -> bytes:
        started_at = perf_counter()
        pdf = SimplePdf()
        logo = _load_png_rgb(LOGO_PATH)
        if logo is not None:
            pdf.add_image(LOGO_RESOURCE_NAME, logo)
        positions, areas, cells, totals_by_position = self._build_matrix(batch, mode=mode)
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
        self._append_photo_pages(pdf, batch)

        content = pdf.build()
        LOGGER.info(
            "Measurement PDF generated: batch_id=%s mode=%s photos=%s bytes=%s duration_ms=%.1f",
            batch.id,
            mode,
            len(batch.photos or []),
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content

    def _build_batch_pdf_version_hash(self, batch: SiteMeasurementBatch, *, mode: str) -> str:
        return build_pdf_version_hash({
            "type": "measurement",
            "generator_version": MEASUREMENT_PDF_CACHE_VERSION,
            "mode": mode,
            "batch": {
                "id": batch.id,
                "number": batch.number,
                "title": batch.title,
                "status": batch.status,
                "updated_at": batch.updated_at,
                "submitted_at": batch.submitted_at,
                "customer_signed_at": batch.customer_signed_at,
                "customer_signature_name": batch.customer_signature_name,
                "customer_signature_place": batch.customer_signature_place,
                "customer_signature_strokes": batch.customer_signature_strokes,
                "worker_signed_at": batch.worker_signed_at,
                "worker_signature_name": batch.worker_signature_name,
                "worker_signature_strokes": batch.worker_signature_strokes,
                "original_submitted_snapshot": batch.original_submitted_snapshot,
            },
            "site": {
                "id": batch.site.id if batch.site else None,
                "number": batch.site.site_number if batch.site else None,
                "name": batch.site.name if batch.site else None,
                "customer": batch.site.customer if batch.site else None,
                "updated_at": batch.site.updated_at if batch.site else None,
            },
            "entries": [
                {
                    "id": entry.id,
                    "item_id": entry.measurement_item_id,
                    "quantity": entry.quantity,
                    "area_or_comment": entry.area_or_comment,
                    "submitted_quantity": entry.submitted_quantity,
                    "submitted_area_or_comment": entry.submitted_area_or_comment,
                    "status": entry.status,
                    "updated_at": entry.updated_at,
                    "item_updated_at": entry.measurement_item.updated_at if entry.measurement_item else None,
                }
                for entry in sorted(batch.entries or [], key=lambda entry: entry.id)
            ],
            "area_rows": [
                {
                    "id": row.id,
                    "area_or_comment": row.area_or_comment,
                    "sort_order": row.sort_order,
                    "updated_at": row.updated_at,
                }
                for row in sorted(batch.area_rows or [], key=lambda row: (row.sort_order, row.id))
            ],
            "photos": [
                {
                    "id": photo.id,
                    "filename": photo.filename,
                    "external_item_id": photo.external_item_id,
                    "file_size_bytes": photo.file_size_bytes,
                    "updated_at": photo.updated_at,
                }
                for photo in sorted(batch.photos or [], key=lambda photo: photo.id)
            ],
        })

    def _append_photo_pages(self, pdf: SimplePdf, batch: SiteMeasurementBatch) -> None:
        photos = sorted(batch.photos, key=lambda photo: (photo.created_at, photo.id))
        if not photos:
            return
        folder_item_id = self._get_photo_folder_item_id(batch.site_id)
        if folder_item_id is None:
            LOGGER.warning("Measurement photo folder is not connected for site %s.", batch.site_id)
            return
        for index, photo in enumerate(photos, start=1):
            photo_started_at = perf_counter()
            try:
                downloaded = ProjectStorageService().download_file_from_folder(
                    drive_id=photo.external_drive_id,
                    folder_item_id=folder_item_id,
                    item_id=photo.external_item_id,
                )
                downloaded_content = downloaded["content"]
                image = _load_uploaded_image_rgb(downloaded_content)
            except (HTTPException, OSError, UnidentifiedImageError, ValueError) as error:
                LOGGER.warning("Measurement photo %s could not be added to PDF: %s", photo.id, error)
                continue
            LOGGER.info(
                "Measurement PDF photo processed: batch_id=%s photo_id=%s source_bytes=%s image_bytes=%s dimensions=%sx%s duration_ms=%.1f",
                batch.id,
                photo.id,
                len(downloaded_content),
                len(image.data),
                image.width,
                image.height,
                (perf_counter() - photo_started_at) * 1000,
            )
            image_name = f"Photo{photo.id}"
            pdf.add_image(image_name, image)
            pdf.add_page(_render_photo_page(batch=batch, photo=photo, image=image, image_name=image_name, index=index, total=len(photos)))

    def _get_photo_folder_item_id(self, site_id: int) -> str | None:
        folder = self.db.scalar(
            select(ProjectFolder).where(
                ProjectFolder.site_id == site_id,
                ProjectFolder.folder_key == MEASUREMENT_PHOTO_FOLDER_KEY,
                ProjectFolder.is_active.is_(True),
            )
        )
        return folder.external_item_id if folder and folder.external_item_id else None

    def build_active_timesheet_pdf(self, *, site_id: int) -> tuple[bytes, str]:
        measurement_base = self.db.scalar(
            select(SiteMeasurementBase)
            .where(
                SiteMeasurementBase.site_id == site_id,
                SiteMeasurementBase.status == "active",
                SiteMeasurementBase.released_to_mobile.is_(True),
            )
            .order_by(SiteMeasurementBase.created_at.desc(), SiteMeasurementBase.id.desc())
        )
        if measurement_base is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine aktive Zeitenliste ausgewählt.")

        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id == measurement_base.id,
                )
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            )
        )
        pdf = SimplePdf()
        logo = _load_png_rgb(LOGO_PATH)
        if logo is not None:
            pdf.add_image(LOGO_RESOURCE_NAME, logo)

        rows_per_page = 18
        item_pages = _chunk(items, rows_per_page) or [[]]
        for page_number, page_items in enumerate(item_pages, start=1):
            pdf.add_page(
                self._render_timesheet_page(
                    measurement_base=measurement_base,
                    items=page_items,
                    page_number=page_number,
                    page_count=len(item_pages),
                    logo=logo,
                )
            )

        safe_name = (measurement_base.name or "Zeitenliste").replace("/", "-").replace(" ", "_")
        return pdf.build(), f"Zeitenliste_{safe_name}.pdf"

    def _render_timesheet_page(
        self,
        *,
        measurement_base: SiteMeasurementBase,
        items: list[SiteMeasurementItem],
        page_number: int,
        page_count: int,
        logo: PdfImage | None,
    ) -> list[bytes]:
        commands: list[bytes] = ["1 1 1 rg 0 0 841.89 595.28 re f 0 0 0 RG 0 0 0 rg".encode("ascii")]
        if logo is not None:
            _image_fit(commands, LOGO_RESOURCE_NAME, x=50, top_y=32, max_width=64, max_height=40, image=logo)

        _text(commands, 130, 545, "Zeitenliste", 20, "F2")
        _text_fitted(commands, 130, 521, measurement_base.name, 10, max_width=360, font="F2")
        _text(commands, 640, 545, f"Blatt {page_number} / {page_count}", 9, "F2")
        _text(commands, 640, 524, f"Stand: {_format_date(datetime.now())}", 8)
        if measurement_base.import_label:
            _text_fitted(commands, 130, 503, f"Import: {measurement_base.import_label}", 8, max_width=420)

        columns = (
            (50, 190, "Position"),
            (190, 470, "Leistung"),
            (470, 540, "Menge"),
            (540, 595, "Einheit"),
            (595, 690, "Min./Einheit"),
            (690, 790, "Gesamt-Min."),
        )
        table_top = 470
        row_height = 21
        _rect(commands, 50, table_top - row_height, 740, row_height)
        for left, right, label in columns:
            _text(commands, left + 5, table_top - 14, label, 8, "F2")
            if left > 50:
                _line(commands, left, table_top - row_height, left, table_top, 0.45)
            _line(commands, right, table_top - row_height, right, table_top, 0.45)

        y = table_top - row_height
        for item in items:
            next_y = y - row_height
            _rect(commands, 50, next_y, 740, row_height)
            for left, _right, _label in columns[1:]:
                _line(commands, left, next_y, left, y, 0.35)
            _cell_text(commands, 55, y - 8, item.position, 130, 7.2, "F2")
            _cell_text(commands, 195, y - 8, item.description, 265, 6.8)
            _text(commands, 475, y - 13, _format_optional_decimal(item.list_quantity), 7.2)
            _text(commands, 545, y - 13, item.unit or "-", 7.2)
            _text(commands, 600, y - 13, _format_optional_decimal(item.minutes_per_unit), 7.2)
            _text(commands, 695, y - 13, _format_optional_decimal(item.list_minutes_total), 7.2)
            y = next_y

        if not items:
            _text(commands, 55, table_top - 43, "Keine Positionen in der aktiven Zeitenliste.", 9)

        return commands

    def _build_matrix(
        self, batch: SiteMeasurementBatch, *, mode: str
    ) -> tuple[
        list[MatrixPosition],
        list[MatrixArea],
        dict[tuple[str, int], MatrixCellValue],
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
        current_quantities: dict[tuple[str, int], Decimal] = {}
        totals_by_position: dict[int, Decimal] = {}
        for area_row in sorted(batch.area_rows or [], key=lambda row: (row.sort_order, row.id)):
            area_label = " ".join(area_row.area_or_comment.split())
            if not area_label:
                continue
            area_key = area_label.casefold()
            area_by_key.setdefault(area_key, MatrixArea(key=area_key, label=area_label))
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
            current_quantities[(area_key, item.id)] = (
                current_quantities.get((area_key, item.id), Decimal("0")) + entry.quantity
            )
            totals_by_position[item.id] = totals_by_position.get(item.id, Decimal("0")) + entry.quantity

        submitted_snapshot = _snapshot_matrix(batch.original_submitted_snapshot)
        if mode == "original" and submitted_snapshot is not None:
            snapshot_cells = {
                key: MatrixCellValue(quantity=quantity)
                for key, quantity in submitted_snapshot.quantities.items()
            }
            return (
                sorted(submitted_snapshot.positions_by_id.values(), key=lambda item: (item.sort_order, item.position)),
                list(submitted_snapshot.areas_by_key.values()),
                snapshot_cells,
                _position_totals(submitted_snapshot.quantities),
            )

        correction_snapshot = (
            _snapshot_matrix(batch.customer_signed_snapshot)
            if mode == "checked" and batch.customer_signed_at is not None
            else None
        )
        original_quantities = correction_snapshot.quantities if correction_snapshot is not None else {}
        if correction_snapshot is not None:
            for item_id, position in correction_snapshot.positions_by_id.items():
                positions_by_id.setdefault(item_id, position)
            for area_key, area in correction_snapshot.areas_by_key.items():
                area_by_key.setdefault(area_key, area)
        cells = {
            key: MatrixCellValue(
                quantity=quantity,
                original_quantity=original_quantities.get(key),
                is_added=correction_snapshot is not None and key not in original_quantities,
            )
            for key, quantity in current_quantities.items()
        }
        if correction_snapshot is not None:
            for key, quantity in original_quantities.items():
                cells.setdefault(
                    key,
                    MatrixCellValue(
                        quantity=Decimal("0"),
                        original_quantity=quantity,
                        is_removed=True,
                    ),
                )
            for item_id, position in list(positions_by_id.items()):
                if item_id not in correction_snapshot.positions_by_id:
                    positions_by_id[item_id] = MatrixPosition(
                        item_id=position.item_id,
                        position=position.position,
                        description=position.description,
                        unit=position.unit,
                        sort_order=position.sort_order,
                        is_added=True,
                    )
            for area_key, area in list(area_by_key.items()):
                if area_key not in correction_snapshot.areas_by_key:
                    area_by_key[area_key] = MatrixArea(key=area.key, label=area.label, is_added=True)
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
        cells: dict[tuple[str, int], MatrixCellValue],
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
            _signature_block(
                commands,
                contractor_name=submitted_by,
                worker_name=batch.worker_signature_name,
                worker_signature_strokes=batch.worker_signature_strokes,
                customer_name=batch.customer_signature_name,
                customer_signature_place=_site_signature_city(batch.site, batch.customer_signature_place),
                customer_signed_at=batch.customer_signed_at,
                customer_signature_strokes=batch.customer_signature_strokes,
            )
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
    _line(commands, 96, PAGE_HEIGHT - 121, 360, PAGE_HEIGHT - 121, 0.9)
    _text(commands, 101, 481, customer, 8)
    _text(commands, 365, 481, "Komissions-Nr.:", 8, "F2")
    _line(commands, 430, PAGE_HEIGHT - 121, 620, PAGE_HEIGHT - 121, 0.9)
    _text(commands, 436, 479, commission, 10.5, "F2", color=(0.7, 0, 0))
    _text(commands, TABLE_LEFT, 456, "Projekt/Bauvorhaben:", 8, "F2")
    _line(commands, 139, PAGE_HEIGHT - 143, 421, PAGE_HEIGHT - 143, 0.9)
    _text(commands, 144, 456, project, 8)
    _text(commands, 420, 456, "Blatt-Nr.:", 8, "F2")
    _line(commands, 456, PAGE_HEIGHT - 143, 509, PAGE_HEIGHT - 143, 0.9)
    sheet_label_size = 5.0 if len(sheet_label) > 8 else 7.4
    _text(commands, 461, 456, sheet_label, sheet_label_size, "F2")
    _text(commands, 510, 456, "Datum:", 8, "F2")
    _line(commands, 553, PAGE_HEIGHT - 143, 620, PAGE_HEIGHT - 143, 0.9)
    _text(commands, 558, 456, date_label, 8)


def _render_photo_page(
    *,
    batch: SiteMeasurementBatch,
    photo: SiteMeasurementBatchPhoto,
    image: PdfImage,
    image_name: str,
    index: int,
    total: int,
) -> list[bytes]:
    site = batch.site
    title = _format_batch_number(site.site_number if site else None, batch.number)
    uploaded_by = _format_user(photo.uploaded_by) or "-"
    commands: list[bytes] = [b"1 1 1 rg 0 0 841.89 595.28 re f 0 0 0 RG 0 0 0 rg"]
    _text(commands, 50, 535, f"Hinterlegte Fotos - {title}", 17, "F2")
    _line(commands, 50, 528, 790, 528, 1.0)
    _text(commands, 50, 508, f"Foto {index} von {total}", 9, "F2", color=(0.08, 0.24, 0.43))
    _text(commands, 50, 493, f"Datei: {photo.filename}", 8)
    _text(commands, 50, 480, f"Hochgeladen: {_format_datetime(photo.created_at) or '-'}", 8)
    _text(commands, 50, 467, f"Monteur: {uploaded_by}", 8)
    _image_fit(commands, image_name, x=50, top_y=150, max_width=740, max_height=380, image=image)
    return commands


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
    cells: dict[tuple[str, int], MatrixCellValue],
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
            _baseline_between(TABLE_TOP, MATRIX_POSITION_BOTTOM, 6.4) + 1.5,
            position.position,
            width,
            6.4,
            "F2",
            color=_correction_color() if position.is_added else None,
        )
        _rotated_cell_text(
            commands,
            x,
            MATRIX_DESCRIPTION_BOTTOM,
            width,
            MATRIX_POSITION_BOTTOM - MATRIX_DESCRIPTION_BOTTOM,
            position.description,
            color=_correction_color() if position.is_added else None,
        )
        _text_centered(
            commands,
            (x + column_right) / 2,
            MATRIX_UNIT_BOTTOM + 3,
            position.unit,
            8.2,
            "F2",
            color=_correction_color() if position.is_added else None,
        )

        for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
            cell = cells.get((area.key, position.item_id))
            if cell is None:
                continue
            row_top = MATRIX_AREA_ROW_LINES[area_index]
            row_bottom = MATRIX_AREA_ROW_LINES[area_index + 1]
            y = _baseline_between(row_top, row_bottom, 6.2)
            _draw_quantity_cell(commands, x, column_right, y, cell)
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
                color=_correction_color() if position.is_added else None,
            )

    for area_index, area in enumerate(areas[:MATRIX_AREA_ROW_COUNT]):
        row_top = MATRIX_AREA_ROW_LINES[area_index]
        row_bottom = MATRIX_AREA_ROW_LINES[area_index + 1]
        y = _baseline_between(row_top, row_bottom, 7.3)
        _text_fitted(
            commands,
            MATRIX_AREA_LABEL_X + 2,
            y,
            area.label,
            7.3,
            max_width=MATRIX_AREA_LABEL_WIDTH - 4,
            color=_correction_color() if area.is_added else None,
        )


def _signature_block(
    commands: list[bytes],
    *,
    contractor_name: str,
    worker_name: str | None = None,
    worker_signature_strokes: list[list[dict[str, float]]] | None = None,
    customer_name: str | None = None,
    customer_signature_place: str | None = None,
    customer_signed_at: datetime | None = None,
    customer_signature_strokes: list[list[dict[str, float]]] | None = None,
) -> None:
    _text(commands, 53, 53.6, "Die Richtigkeit des Aufmaßes und die", 7)
    _text(commands, 53, 42.6, "ordnungsgemäße Montage bescheinigen:", 7)
    _text(commands, 54, 20.0, "Ort / Datum:", 7, "F2")
    if customer_signed_at is not None:
        if customer_signature_place:
            _text_fitted(commands, 139, 19.8, customer_signature_place, 6.8, max_width=48)
        _text(commands, 232, 19.8, _format_date(customer_signed_at), 6.8, align_right=True)
    _line(commands, 136, 14.6, 233.5, 14.6, 0.8)

    _text(commands, 248.5, 45.4, "Name Auftragnehmer (BEG):", 7, "F2")
    _text_fitted(commands, 396, 45.0, worker_name or contractor_name, 8, max_width=158)
    _line(commands, 394.9, 41.3, 566.6, 41.3, 0.8)
    _text(commands, 598.6, 44.6, "Unterschrift:", 7, "F2")
    _draw_signature(commands, worker_signature_strokes, x=661, y=43.7, width=103, height=24)
    _line(commands, 661, 41.3, 764, 41.3, 0.8)

    _text(commands, 250.2, 20.4, "Name Auftraggeber (Kunde):", 7, "F2")
    if customer_name:
        _text_fitted(commands, 396, 19.8, customer_name, 8, max_width=158)
    _line(commands, 394.9, 14.6, 566.6, 14.6, 0.8)
    _text(commands, 598.6, 19.6, "Unterschrift:", 7, "F2")
    _draw_signature(commands, customer_signature_strokes, x=661, y=17.0, width=103, height=24)
    _line(commands, 661, 14.6, 764, 14.6, 0.8)


def _site_signature_city(site, fallback_place: str | None = None) -> str:
    if site is not None:
        city = _clean_signature_place_part(getattr(site, "city", None))
        if city:
            return city

    for value in (
        fallback_place,
        getattr(site, "address", None) if site is not None else None,
        getattr(site, "location", None) if site is not None else None,
    ):
        city = _city_from_location_text(value)
        if city:
            return city
    return ""


def _city_from_location_text(value: str | None) -> str:
    text = _clean_signature_place_part(value)
    if not text:
        return ""

    candidates = [part.strip() for part in text.split(",") if part.strip()] or [text]
    for candidate in reversed(candidates):
        postal_city_match = re.match(r"^(?:[A-Z]{1,3}-)?\d{4,5}\s+(.+)$", candidate)
        if postal_city_match:
            return postal_city_match.group(1).strip()

    if len(candidates) > 1:
        return ""
    if re.search(r"\d", text):
        return ""
    return text


def _clean_signature_place_part(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split()).strip()


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
    _line(
        commands,
        MATRIX_SECTION_LABEL_RIGHT,
        MATRIX_TOTAL_TOP,
        MATRIX_SECTION_LABEL_RIGHT,
        PAGE_HEIGHT - 336.3,
        0.85,
    )
    _line(commands, MATRIX_X, MATRIX_BOTTOM, MATRIX_X, TABLE_TOP, 1.35)

    _line(commands, TABLE_LEFT, MATRIX_BOTTOM, TABLE_LEFT, TABLE_TOP, 1.6)
    _line(commands, TABLE_RIGHT, MATRIX_BOTTOM, TABLE_RIGHT, TABLE_TOP, 1.6)
    _line(commands, TABLE_LEFT, TABLE_TOP, TABLE_RIGHT, TABLE_TOP, 1.6)
    _line(commands, TABLE_LEFT, MATRIX_BOTTOM, TABLE_RIGHT, MATRIX_BOTTOM, 1.6)


def _draw_grand_total(commands: list[bytes]) -> None:
    y = _baseline_between(MATRIX_TOTAL_TOP, MATRIX_BOTTOM, 7.2)
    _text(commands, MATRIX_AREA_LABEL_X + 4, y, "Gesamtsumme:", 7.2, "F2")


def _draw_quantity_cell(
    commands: list[bytes],
    left: float,
    right: float,
    y: float,
    cell: MatrixCellValue,
) -> None:
    center = (left + right) / 2
    width = right - left
    if cell.is_removed and cell.original_quantity is not None:
        _text_centered_struck(commands, center, y, _format_decimal(cell.original_quantity), 5.5)
        return
    if cell.is_corrected and cell.original_quantity is not None:
        _text_centered_struck(
            commands,
            center - width * 0.18,
            y,
            _format_decimal(cell.original_quantity),
            4.8,
        )
        _text_centered(
            commands,
            center + width * 0.22,
            y,
            _format_decimal(cell.quantity),
            5.4,
            "F2",
            color=_correction_color(),
        )
        return
    _text_centered(
        commands,
        center,
        y,
        _format_decimal(cell.quantity),
        6.2,
        color=_correction_color() if cell.is_added else None,
    )


def _text_centered_struck(
    commands: list[bytes],
    center_x: float,
    y: float,
    text: str,
    size: float,
) -> None:
    text_width = _text_width(text, size)
    _text(commands, center_x - text_width / 2, y, text, size)
    _line(
        commands,
        center_x - text_width / 2,
        y + size * 0.35,
        center_x + text_width / 2,
        y + size * 0.35,
        0.55,
    )


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
        output = BytesIO()
        rgb.save(output, format="JPEG", quality=PHOTO_JPEG_QUALITY, optimize=True)
        return PdfImage(width=width, height=height, data=output.getvalue(), filter_name="DCTDecode")


def _chunk[T](rows: list[T], size: int) -> list[list[T]]:
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def _format_batch_number(site_number: str | None, number: int) -> str:
    prefix = site_number or "Aufmaß"
    return f"{prefix}.{number:02d}" if site_number else f"Aufmaß {number}"


def _format_sheet_label(title: str, page_number: int, page_count: int) -> str:
    if page_count <= 1:
        return title
    return f"{title}.{page_number:02d}"


def _snapshot_matrix(snapshot: dict[str, object] | None) -> SnapshotMatrix | None:
    if not snapshot:
        return None
    entries = snapshot.get("entries")
    if not isinstance(entries, list):
        return None

    positions_by_id: dict[int, MatrixPosition] = {}
    areas_by_key: dict[str, MatrixArea] = {}
    quantities: dict[tuple[str, int], Decimal] = {}
    for raw_entry in entries:
        if not isinstance(raw_entry, dict):
            continue
        item_id = raw_entry.get("measurement_item_id")
        position = raw_entry.get("position")
        description = raw_entry.get("description")
        unit = raw_entry.get("unit")
        sort_order = raw_entry.get("sort_order")
        area = raw_entry.get("area_or_comment")
        quantity = raw_entry.get("quantity")
        if (
            not isinstance(item_id, int)
            or not isinstance(position, str)
            or not isinstance(description, str)
            or not isinstance(area, str)
            or quantity is None
        ):
            continue
        sort_order_value = sort_order if isinstance(sort_order, int) else 0
        area_key = " ".join(area.split()).casefold()
        positions_by_id.setdefault(
            item_id,
            MatrixPosition(
                item_id=item_id,
                position=position,
                description=description,
                unit=unit if isinstance(unit, str) else "",
                sort_order=sort_order_value,
            ),
        )
        areas_by_key.setdefault(area_key, MatrixArea(key=area_key, label=" ".join(area.split())))
        quantities[(area_key, item_id)] = quantities.get((area_key, item_id), Decimal("0")) + Decimal(
            str(quantity)
        )
    return SnapshotMatrix(
        positions_by_id=positions_by_id,
        areas_by_key=areas_by_key,
        quantities=quantities,
    )


def _position_totals(quantities: dict[tuple[str, int], Decimal]) -> dict[int, Decimal]:
    totals: dict[int, Decimal] = {}
    for (_area_key, item_id), quantity in quantities.items():
        totals[item_id] = totals.get(item_id, Decimal("0")) + quantity
    return totals


def _format_decimal(value: Decimal) -> str:
    return f"{value:.2f}".replace(".", ",")


def _format_optional_decimal(value: Decimal | None) -> str:
    return "-" if value is None else _format_decimal(value)


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
        "billed": "Abgeschlossen",
        "approved": "Abgeschlossen",
        "reviewed": "Geprüft",
        "submitted": "Eingereicht",
        "rejected": "Eingereicht",
        "customer_signed": "Unterschrieben",
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
    color: tuple[float, float, float] | None = None,
) -> None:
    text_width = _text_width(text, size)
    text_x = x - text_width if align_right else x
    text_command = (
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
    if color is None:
        commands.append(text_command)
        return
    commands.append(
        b"q "
        + _number(color[0])
        + b" "
        + _number(color[1])
        + b" "
        + _number(color[2])
        + b" rg "
        + text_command
        + b" Q"
    )


def _text_centered(
    commands: list[bytes],
    center_x: float,
    y: float,
    text: str,
    size: float,
    font: str = "F1",
    *,
    color: tuple[float, float, float] | None = None,
) -> None:
    text_width = _text_width(text, size)
    _text(commands, center_x - text_width / 2, y, text, size, font, color=color)


def _text_rotated(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    size: float,
    font: str = "F1",
    *,
    color: tuple[float, float, float] | None = None,
) -> None:
    text_command = (
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
    if color is None:
        commands.append(text_command)
        return
    commands.append(
        b"q "
        + _number(color[0])
        + b" "
        + _number(color[1])
        + b" "
        + _number(color[2])
        + b" rg "
        + text_command
        + b" Q"
    )


def _rotated_cell_text(
    commands: list[bytes],
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    *,
    color: tuple[float, float, float] | None = None,
) -> None:
    size = 6.8
    line_height = 7.4
    max_chars = max(16, int((height - 8) / (size * 0.48)))
    lines = _wrap_ellipsis(text, width=max_chars, max_lines=5)
    block_width = (len(lines) - 1) * line_height
    start_x = x + (width - block_width) / 2 + 2
    for index, line in enumerate(lines):
        _text_rotated(commands, start_x + index * line_height, y + 4, line, size, color=color)


def _cell_text(
    commands: list[bytes],
    x: float,
    y: float,
    text: str,
    width: float,
    size: float,
    font: str = "F1",
    *,
    color: tuple[float, float, float] | None = None,
) -> None:
    lines = _wrapped(text, max(4, int(width / (size * 0.55))))[:2]
    for index, line in enumerate(lines):
        _text(commands, x + 2, y - index * (size + 1.5), line, size, font, color=color)


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
    color: tuple[float, float, float] | None = None,
) -> None:
    _text(
        commands,
        x,
        y,
        _trim_to_width(text, size=size, max_width=max_width),
        size,
        font,
        color=color,
    )


def _trim_to_width(value: str, *, size: float, max_width: float) -> str:
    text = " ".join((value or "").split())
    if _text_width(text, size) <= max_width:
        return text
    max_chars = max(1, int(max_width / (size * 0.48)))
    return _trim_text(text, max_chars)


def _text_width(text: str, size: float) -> float:
    return len(text) * size * 0.48


def _correction_color() -> tuple[float, float, float]:
    return (0.7, 0, 0)


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
