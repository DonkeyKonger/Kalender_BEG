from decimal import Decimal
from io import BytesIO

import pytest
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementAreaRow,
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.services.measurement_pdf_service import (
    MATRIX_COLUMN_COUNT,
    MatrixArea,
    MatrixCellValue,
    MatrixPosition,
    MeasurementPdfService,
    _build_logical_measurement_blocks,
    _build_measurement_pdf_pages,
)


def _areas(count: int) -> list[MatrixArea]:
    return [
        MatrixArea(key=f"area-{index:02d}", label=f"Bereich {index:02d}")
        for index in range(1, count + 1)
    ]


def _positions(count: int) -> list[MatrixPosition]:
    return [
        MatrixPosition(
            item_id=index,
            position=f"P{index}",
            description=f"Position {index}",
            unit="m",
            sort_order=index,
        )
        for index in range(1, count + 1)
    ]


@pytest.mark.parametrize(
    ("row_count", "expected_block_sizes"),
    [
        (0, [0]),
        (1, [1]),
        (11, [11]),
        (12, [12]),
        (13, [12, 1]),
        (24, [12, 12]),
        (25, [12, 12, 1]),
    ],
)
def test_measurement_pdf_splits_real_rows_into_logical_blocks(
    row_count: int,
    expected_block_sizes: list[int],
):
    blocks = _build_logical_measurement_blocks(
        positions=[],
        areas=_areas(row_count),
        cells={},
    )

    assert [len(block.areas) for block in blocks] == expected_block_sizes


def test_measurement_pdf_filters_positions_and_totals_per_logical_block():
    areas = _areas(13)
    positions = _positions(3)
    cells = {
        (areas[0].key, 1): MatrixCellValue(quantity=Decimal("10")),
        (areas[1].key, 1): MatrixCellValue(quantity=Decimal("20")),
        (areas[0].key, 2): MatrixCellValue(quantity=Decimal("5")),
        (areas[0].key, 3): MatrixCellValue(quantity=Decimal("0")),
        (areas[12].key, 1): MatrixCellValue(quantity=Decimal("5")),
        (areas[12].key, 2): MatrixCellValue(quantity=Decimal("0")),
        (areas[12].key, 3): MatrixCellValue(quantity=Decimal("8")),
    }

    blocks = _build_logical_measurement_blocks(
        positions=positions,
        areas=areas,
        cells=cells,
    )

    assert [[position.item_id for position in block.positions] for block in blocks] == [
        [1, 2],
        [1, 3],
    ]
    assert blocks[0].totals_by_position == {1: Decimal("30"), 2: Decimal("5")}
    assert blocks[1].totals_by_position == {1: Decimal("5"), 3: Decimal("8")}
    assert Decimal("35") not in blocks[0].totals_by_position.values()
    assert Decimal("35") not in blocks[1].totals_by_position.values()


def test_measurement_pdf_keeps_removed_correction_visible_but_ignores_plain_zero():
    [area] = _areas(1)
    positions = _positions(2)
    cells = {
        (area.key, 1): MatrixCellValue(
            quantity=Decimal("0"),
            original_quantity=Decimal("10"),
            is_removed=True,
        ),
        (area.key, 2): MatrixCellValue(quantity=Decimal("0")),
    }

    [block] = _build_logical_measurement_blocks(
        positions=positions,
        areas=[area],
        cells=cells,
    )

    assert [position.item_id for position in block.positions] == [1]
    assert block.totals_by_position == {1: Decimal("0")}


def test_measurement_pdf_paginates_columns_inside_each_logical_block():
    areas = _areas(13)
    positions = _positions(MATRIX_COLUMN_COUNT + 1)
    cells = {
        (areas[0].key, position.item_id): MatrixCellValue(quantity=Decimal("1"))
        for position in positions
    }
    cells[(areas[12].key, 1)] = MatrixCellValue(quantity=Decimal("2"))
    blocks = _build_logical_measurement_blocks(
        positions=positions,
        areas=areas,
        cells=cells,
    )

    pages = _build_measurement_pdf_pages(blocks)

    assert [page.logical_block_index for page in pages] == [0, 0, 1]
    assert [len(page.positions) for page in pages] == [MATRIX_COLUMN_COUNT, 1, 1]
    assert [len(page.areas) for page in pages] == [12, 12, 1]
    assert pages[0].totals_by_position[1] == Decimal("1")
    assert pages[1].totals_by_position[MATRIX_COLUMN_COUNT + 1] == Decimal("1")
    assert pages[2].totals_by_position == {1: Decimal("2")}


def test_empty_measurement_keeps_existing_blank_position_columns():
    positions = _positions(MATRIX_COLUMN_COUNT + 1)

    [block] = _build_logical_measurement_blocks(
        positions=positions,
        areas=[],
        cells={},
    )
    pages = _build_measurement_pdf_pages([block])

    assert [len(page.positions) for page in pages] == [MATRIX_COLUMN_COUNT, 1]
    assert all(page.areas == [] for page in pages)


def test_rendered_measurement_pdf_uses_block_totals_instead_of_global_total():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = Session(engine)
    site = Site(
        name="Testbaustelle",
        site_number="8007",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    base = SiteMeasurementBase(
        site=site,
        name="Aufmaßbasis Bestand",
        base_type="mixed",
        status="active",
        released_to_mobile=True,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="P1",
        description="Kabel liefern und montieren",
        unit="m",
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="reviewed",
    )
    rows = [
        SiteMeasurementAreaRow(
            measurement_batch=batch,
            site=site,
            area_or_comment=f"Bereich {index:02d}",
            sort_order=index,
        )
        for index in range(1, 14)
    ]
    entries = [
        SiteMeasurementEntry(
            measurement_batch=batch,
            measurement_item=item,
            site=site,
            quantity=quantity,
            area_or_comment=area,
            status="submitted",
        )
        for area, quantity in (
            ("Bereich 01", Decimal("10")),
            ("Bereich 02", Decimal("20")),
            ("Bereich 13", Decimal("5")),
        )
    ]
    db.add_all([site, base, item, batch, *rows, *entries])
    db.commit()

    content = MeasurementPdfService(db)._render_batch_pdf_content(batch=batch, mode="checked")
    page_texts = [page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages]

    assert len(page_texts) == 2
    assert "8007.01.01" in page_texts[0]
    assert "8007.01.02" in page_texts[1]
    assert "30,00" in page_texts[0]
    assert "5,00" in page_texts[1]
    assert all("35,00" not in page_text for page_text in page_texts)
    assert "Fortsetzung auf folgendem Blatt" in page_texts[0]
    assert "Fortsetzung auf folgendem Blatt" not in page_texts[1]
    assert "Name Auftraggeber (Kunde):" in page_texts[1]
