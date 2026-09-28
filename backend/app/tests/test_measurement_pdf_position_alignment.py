from io import BytesIO

import pytest
from pypdf import PdfReader

from app.services.measurement_pdf_service import (
    MATRIX_COLUMN_BOUNDARIES,
    MATRIX_POSITION_BOTTOM,
    TABLE_TOP,
    MatrixPosition,
    SimplePdf,
    _baseline_between,
    _draw_measurement_matrix,
)


@pytest.mark.parametrize("original", ["", "   ", None])
@pytest.mark.parametrize("number", ["N2.1", "1.01.05.140"])
def test_later_number_has_same_baseline_font_and_left_inset_as_existing_number(original, number):
    commands = []
    _draw_measurement_matrix(
        commands=commands,
        positions=[
            MatrixPosition(1, number, "Vorher", "m", 1),
            MatrixPosition(2, number, "Nachher", "m", 2,
                           original_position=original, is_added=original is None),
        ],
        areas=[], cells={}, totals_by_position={},
    )
    pdf = SimplePdf()
    pdf.add_page(commands)
    labels = []
    PdfReader(BytesIO(pdf.build())).pages[0].extract_text(
        visitor_text=lambda text, cm, tm, font, size: labels.append((text.strip(), tm[4], tm[5], size, font.get("/BaseFont") if font else None))
    )
    black = [label for label in labels if label[0] and label[1] == MATRIX_COLUMN_BOUNDARIES[0] + 2]
    red = [label for label in labels if label[0] and label[1] == MATRIX_COLUMN_BOUNDARIES[1] + 2]
    assert black and red
    assert [(text, y, size, font) for text, x, y, size, font in black] == [(text, y, size, font) for text, x, y, size, font in red]
    assert red[0][2] == pytest.approx(_baseline_between(TABLE_TOP, MATRIX_POSITION_BOTTOM, 6.4) + 1.5, abs=0.01)
    assert any(command.startswith(b"q 0.7 0 0 rg BT /F2 6.4 Tf 275.2 ") for command in commands)
    assert not any(b"0.7 0 0 RG" in command for command in commands)


def test_replaced_nonempty_position_keeps_original_struck_out_above_new_number():
    commands = []
    _draw_measurement_matrix(
        commands=commands,
        positions=[MatrixPosition(1, "N2.1", "Leistung", "m", 1, original_position="N1.1")],
        areas=[], cells={}, totals_by_position={},
    )
    pdf = SimplePdf()
    pdf.add_page(commands)
    labels = []
    PdfReader(BytesIO(pdf.build())).pages[0].extract_text(
        visitor_text=lambda text, cm, tm, font, size: labels.append((text.strip(), tm[5]))
    )
    assert ("N1.1", pytest.approx(TABLE_TOP - 6, abs=0.01)) in labels
    assert ("N2.1", pytest.approx(MATRIX_POSITION_BOTTOM + 5, abs=0.01)) in labels
    assert any(b"0.7 0 0 RG" in command for command in commands)
