from __future__ import annotations

import io

import pandas as pd
import pytest
from reportlab.pdfgen import canvas

from app.services import price_comparison_pdf_parser as parser
from app.services.price_comparison_pdf_parser import (
    _aggregate_parsed_positions,
    _parse_obo_compact_line,
    extract_prices_from_pdf,
    parse_row_text_fallback,
)


class _TablePage:
    width = 600
    height = 800

    def __init__(self, table, text=""):
        self.table = table
        self.text = text

    def crop(self, _box):
        return self

    def extract_text(self):
        return self.text

    def extract_tables(self):
        return [self.table]


class _TablePdf:
    def __init__(self, table, text=""):
        self.pages = [_TablePage(table, text)]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _synthetic_offer_pdf(lines: list[str]) -> bytes:
    output = io.BytesIO()
    document = canvas.Canvas(output)
    y = 800
    for line in lines:
        document.drawString(72, y, line)
        y -= 22
    document.save()
    return output.getvalue()


def test_empty_material_after_quantity_is_never_a_price() -> None:
    line = "6000016 Montageaufwand 95,00 Stück 1 EUR"
    parsed = _parse_obo_compact_line(line)

    assert parsed == {
        "art": "6000016",
        "qty": 95.0,
        "unit": "Stück",
        "material": None,
        "per": 1,
        "price": None,
        "price_validated": False,
    }
    assert parse_row_text_fallback(line) == ("6000016", None)


@pytest.mark.parametrize(
    ("line", "quantity", "per", "price"),
    [
        ("6059252 MKSMU 620 FT 95,00 Meter 16,15 1 EUR", 95.0, 1, 16.15),
        ("3498683 BZ3 8x75/0-20 161,54 Stück 68,53 100 EUR", 161.54, 100, 0.6853),
        ("6406122 FRSB 6x12 F 30,00 Stück 105,10 1000 EUR", 30.0, 1000, 0.1051),
        ("6355798 TKS-S-30 ZL 46,66 Paar 11,47 1 EUR", 46.66, 1, 11.47),
        ("6338968 HILF.KON. 1.000,00 Kilogramm 10,30 1 EUR", 1000.0, 1, 10.30),
        (
            "6338941 HILF.KON. 350,00 Kilogram EUR 22,85 1 m Hilfkonstruktion Profil Angebot per kg V2A",
            350.0,
            1,
            22.85,
        ),
        ("6047611 RKSM 10,00 Stk. 68,53 100 EUR", 10.0, 100, 0.6853),
        ("7400265 S2 25028-2 16,00MTR 32,44 1 EUR", 16.0, 1, 32.44),
        ("6338615 US 7 K 30 A2 100,00STCK 59,82 1 EUR", 100.0, 1, 59.82),
        ("6277290 GS-KUP70 90,00 VPE 2,92 1 EUR", 90.0, 1, 2.92),
        ("1234567 Nullpreis 0,00 Stück 0,00 1 EUR", 0.0, 1, 0.0),
    ],
)
def test_compact_material_and_per_are_anchored_and_auditable(
    line: str,
    quantity: float,
    per: int,
    price: float,
) -> None:
    parsed = _parse_obo_compact_line(line)

    assert parsed is not None
    assert parsed["qty"] == pytest.approx(quantity)
    assert parsed["per"] == per
    assert parsed["price"] == pytest.approx(price)
    assert parsed["price_validated"] is True


@pytest.mark.parametrize(
    ("line", "per", "price"),
    [
        (
            "6047611 RKSM 610 FS 300,00 Meter 4,27 1 1.281,00 EUR",
            1,
            4.27,
        ),
        (
            "3498683 BZ3 8x75/0-20 453,00 Stück 300,00 100 1.359,00 EUR",
            100,
            3.0,
        ),
        (
            "6047611 RKSM 610 FS 300,00 Meter EUR 4,27 1 1.281,00 €",
            1,
            4.27,
        ),
    ],
)
def test_position_total_after_per_is_not_used_as_unit_price(
    line: str,
    per: int,
    price: float,
) -> None:
    parsed = _parse_obo_compact_line(line)

    assert parsed is not None
    assert parsed["per"] == per
    assert parsed["price"] == pytest.approx(price)
    assert parsed["price_validated"] is True


@pytest.mark.parametrize(
    ("material_and_per", "expected_per"),
    [
        ("1", 1),
        ("- 100", 100),
        ("ungültig 1", 1),
        ("4,27 0", None),
    ],
)
def test_position_total_never_substitutes_for_missing_or_invalid_material(
    material_and_per: str,
    expected_per: int | None,
) -> None:
    parsed = _parse_obo_compact_line(
        f"6000016 Montageaufwand 95,00 Stück {material_and_per} 9.025,00 EUR"
    )

    assert parsed is not None
    assert parsed["qty"] == pytest.approx(95.0)
    assert parsed["material"] is None
    assert parsed["per"] == expected_per
    assert parsed["price"] is None
    assert parsed["price_validated"] is False


def test_synthetic_pdf_reads_position_totals_without_changing_price_basis() -> None:
    parsed = extract_prices_from_pdf(
        _synthetic_offer_pdf(
            [
                "01.05.2026",
                "Angebot: TOTAL-1",
                "6047611 RKSM 610 FS 300,00 Meter 4,27 1 1.281,00 EUR",
                "3498683 BZ3 8x75/0-20 453,00 Stück 300,00 100 1.359,00 EUR",
                "6000016 Montageaufwand 95,00 Stück 1 9.025,00 EUR",
            ]
        ),
        source_name="position-total.pdf",
    ).set_index("Artikelnummer")

    assert parsed.loc["6047611", "Preis"] == pytest.approx(4.27)
    assert parsed.loc["6047611", "Preiseinheit (PDF)"] == 1
    assert parsed.loc["3498683", "Preis"] == pytest.approx(3.0)
    assert parsed.loc["3498683", "Preiseinheit (PDF)"] == 100
    assert pd.isna(parsed.loc["6000016", "Preis"])
    assert bool(parsed.loc["6000016", "Preis_validiert"]) is False


def test_empty_material_and_per_after_quantity_remain_an_unpriced_position() -> None:
    parsed = _parse_obo_compact_line("6338941 HILF.KON. 10,00 Kilogram EUR")

    assert parsed == {
        "art": "6338941",
        "qty": 10.0,
        "unit": "Kilogramm",
        "material": None,
        "per": None,
        "price": None,
        "price_validated": False,
    }


def test_missing_quantity_with_unit_and_material_keeps_the_valid_price() -> None:
    parsed = _parse_obo_compact_line("6109887 VH-POS Stück 189,26 1 EUR")

    assert parsed is not None
    assert parsed["qty"] is None
    assert parsed["unit"] == "Stück"
    assert parsed["price"] == pytest.approx(189.26)
    assert parsed["price_validated"] is True


def test_explicit_zero_material_without_quantity_is_preserved() -> None:
    parsed = _parse_obo_compact_line("9480480 RKSM610E20 0,00 1 EUR")

    assert parsed is not None
    assert parsed["qty"] is None
    assert parsed["unit"] is None
    assert parsed["price"] == 0.0
    assert parsed["price_validated"] is True


@pytest.mark.parametrize(
    "line",
    [
        "9480482 RKSM620E20 Meter 1 EUR",
        "1234567 LAR30/90 Meter 1 EUR",
        "1234567 KB 50 Stück 1 EUR",
        "1234567 DOP A2 Stück 1 EUR",
        "1234567 Pendel 100 Stück 1 EUR",
        "1234567 U9011Stück 1 EUR",
    ],
)
def test_type_digits_are_never_inferred_as_compact_quantities(line: str) -> None:
    parsed = _parse_obo_compact_line(line)

    assert parsed is not None
    assert parsed["qty"] is None
    assert parsed["price"] is None
    assert parsed["price_validated"] is False


@pytest.mark.parametrize("minus", ["-", "−"])
def test_negative_compact_quantity_is_never_reinterpreted_as_positive(minus: str) -> None:
    parsed = _parse_obo_compact_line(
        f"6047611 RKSM 620 FS {minus}2,00 Stück 10,00 1 EUR"
    )

    assert parsed is not None
    assert parsed["qty"] is None
    assert parsed["price"] == pytest.approx(10.0)
    assert parsed["price_validated"] is True


def test_synthetic_pdf_keeps_unpriced_labor_and_keeps_zero_price() -> None:
    parsed = extract_prices_from_pdf(
        _synthetic_offer_pdf(
            [
                "01.05.2026",
                "Angebot: PARSER-1",
                "6000016 Montageaufwand 95,00 Stück 1 EUR",
                "6059252 MKSMU 620 FT 95,00 Meter 16,15 1 EUR",
                "3498683 BZ3 8x75/0-20 10,00 Stück 68,53 100 EUR",
                "1234567 Nullpreis 0,00 Stück 0,00 1 EUR",
            ]
        ),
        source_name="validated.pdf",
    )

    by_article = parsed.set_index("Artikelnummer")
    assert pd.isna(by_article.loc["6000016", "Preis"])
    assert by_article.loc["6000016", "Menge"] == pytest.approx(95.0)
    assert by_article.loc["6000016", "Preiseinheit (PDF)"] == 1
    assert bool(by_article.loc["6000016", "Preis_validiert"]) is False
    assert by_article.loc["6059252", "Preis"] == pytest.approx(16.15)
    assert by_article.loc["3498683", "Preis"] == pytest.approx(0.6853)
    assert by_article.loc["1234567", "Preis"] == 0.0
    assert by_article.loc["3498683", "Preiseinheit (PDF)"] == 100
    assert by_article.drop(index="6000016")["Preis_validiert"].astype(bool).all()


@pytest.mark.parametrize(
    ("header", "row", "expected_quantity"),
    [
        (
            ["Art.Nr.", "Menge", "ME", "Preis", "per"],
            ["6047611", "10,00", "Stück", "68,53", "100"],
            10.0,
        ),
        (
            ["Art.Nr.", "Menge", "ME", "Material", "per"],
            ["6047611", "10,00 Stück 68,53 100", None, None, None],
            10.0,
        ),
        (
            ["Art.Nr.", "Menge", "ME", "Material", "per"],
            ["6047611", None, "Stück", "68,53", "100"],
            None,
        ),
    ],
)
def test_table_price_per_is_normalized_and_merged_quantity_is_never_numeric_garbage(
    monkeypatch,
    header,
    row,
    expected_quantity,
) -> None:
    monkeypatch.setattr(parser.pdfplumber, "open", lambda _source: _TablePdf([header, row]))

    parsed = extract_prices_from_pdf(b"synthetic", source_name="table.pdf")

    assert len(parsed) == 1
    assert parsed.iloc[0]["Preis"] == pytest.approx(0.6853)
    assert parsed.iloc[0]["Preiseinheit (PDF)"] == 100
    if expected_quantity is None:
        assert pd.isna(parsed.iloc[0]["Menge"])
    else:
        assert parsed.iloc[0]["Menge"] == pytest.approx(expected_quantity)


@pytest.mark.parametrize("invalid_per", ["0", "-1", "ungültig"])
def test_nonempty_invalid_explicit_per_fails_closed(monkeypatch, invalid_per) -> None:
    table = [
        ["Art.Nr.", "Menge", "ME", "Preis", "per"],
        ["6047611", "10,00", "Stück", "68,53", invalid_per],
    ]
    monkeypatch.setattr(parser.pdfplumber, "open", lambda _source: _TablePdf(table))

    parsed = extract_prices_from_pdf(b"synthetic", source_name="invalid-per.pdf")

    assert len(parsed) == 1
    assert pd.isna(parsed.iloc[0]["Preis"])
    assert pd.isna(parsed.iloc[0]["Preiseinheit (PDF)"])
    assert bool(parsed.iloc[0]["Preis_validiert"]) is False


def test_missing_explicit_per_defaults_to_one(monkeypatch) -> None:
    table = [
        ["Art.Nr.", "Menge", "ME", "Preis", "per"],
        ["6047611", "10,00", "Stück", "68,53", None],
    ]
    monkeypatch.setattr(parser.pdfplumber, "open", lambda _source: _TablePdf(table))

    parsed = extract_prices_from_pdf(b"synthetic", source_name="missing-per.pdf")

    assert len(parsed) == 1
    assert parsed.iloc[0]["Preis"] == pytest.approx(68.53)
    assert parsed.iloc[0]["Preiseinheit (PDF)"] == 1
    assert bool(parsed.iloc[0]["Preis_validiert"]) is True


def test_incomplete_text_shadow_does_not_duplicate_validated_table_position(
    monkeypatch,
) -> None:
    table = [
        ["Art.Nr. Typ Menge ME Währ. Material per"],
        ["6338941 HILF.KON. 350,00 Kilogram EUR 22,85 1 m"],
    ]
    text = "6338941 HILF.KON. 350,00 Kilogram EUR"
    monkeypatch.setattr(
        parser.pdfplumber,
        "open",
        lambda _source: _TablePdf(table, text),
    )

    parsed = extract_prices_from_pdf(b"synthetic", source_name="split-text.pdf")

    assert len(parsed) == 1
    assert parsed.iloc[0]["Preis"] == pytest.approx(22.85)
    assert parsed.iloc[0]["Menge"] == pytest.approx(350.0)
    assert bool(parsed.iloc[0]["Preis_validiert"]) is True


def test_exact_text_match_is_resolved_before_same_identity_unpriced_text(
    monkeypatch,
) -> None:
    table = [
        ["Art.Nr. Typ Menge ME Material per"],
        ["6047611 RKSM 5,00 Meter 10,00 1 EUR"],
    ]
    text = "\n".join(
        [
            "6047611 RKSM 5,00 Meter 1 EUR",
            "6047611 RKSM 5,00 Meter 10,00 1 EUR",
        ]
    )
    monkeypatch.setattr(
        parser.pdfplumber,
        "open",
        lambda _source: _TablePdf(table, text),
    )

    parsed = extract_prices_from_pdf(b"synthetic", source_name="two-pass.pdf")

    assert len(parsed) == 2
    validity = parsed["Preis_validiert"].astype(bool)
    assert parsed.loc[validity, "Preis"].iloc[0] == pytest.approx(10.0)
    assert pd.isna(parsed.loc[~validity, "Preis"].iloc[0])
    assert parsed["Menge"].tolist() == [5.0, 5.0]


@pytest.mark.parametrize("position_count", [1, 2])
def test_position_total_table_and_text_are_deduplicated_by_occurrence(
    monkeypatch,
    position_count: int,
) -> None:
    line = "6047611 RKSM 610 FS 300,00 Meter 4,27 1 1.281,00 EUR"
    table = [
        ["Art.Nr. Typ Menge ME Material per Gesamt"],
        *[[line] for _ in range(position_count)],
    ]
    text = "\n".join([line] * position_count)
    monkeypatch.setattr(
        parser.pdfplumber,
        "open",
        lambda _source: _TablePdf(table, text),
    )

    parsed = extract_prices_from_pdf(b"synthetic", source_name="total-dedup.pdf")

    assert len(parsed) == 1
    assert parsed.iloc[0]["Menge"] == pytest.approx(300.0 * position_count)
    assert parsed["Preis"].eq(4.27).all()


def test_priced_and_unpriced_rows_of_same_article_remain_separate() -> None:
    frame = pd.DataFrame(
        [
            {
                "Artikelnummer": "6000004",
                "Quelle": "mixed.pdf",
                "PDF_Order": 1,
                "Preis": None,
                "Menge": 37.0,
                "Einheit (PDF)": "Stück",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": False,
            },
            {
                "Artikelnummer": "6000004",
                "Quelle": "mixed.pdf",
                "PDF_Order": 2,
                "Preis": 3.0,
                "Menge": 38.0,
                "Einheit (PDF)": "Stück",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            },
        ]
    )

    result = _aggregate_parsed_positions(frame)

    assert len(result) == 2
    validity = result["Preis_validiert"].astype(bool)
    unpriced = result[~validity].iloc[0]
    priced = result[validity].iloc[0]
    assert pd.isna(unpriced["Preis"])
    assert unpriced["Menge"] == pytest.approx(37.0)
    assert priced["Preis"] == pytest.approx(3.0)
    assert priced["Menge"] == pytest.approx(38.0)


def test_total_price_header_is_not_used_as_the_unit_price(monkeypatch) -> None:
    table = [
        ["Art.Nr.", "Menge", "ME", "Einzelpreis", "Gesamtpreis", "per"],
        ["6047611", "10,00", "Stück", "68,53", "685,30", "100"],
    ]
    monkeypatch.setattr(parser.pdfplumber, "open", lambda _source: _TablePdf(table))

    parsed = extract_prices_from_pdf(b"synthetic", source_name="total-price.pdf")

    assert len(parsed) == 1
    assert parsed.iloc[0]["Preis"] == pytest.approx(0.6853)
    assert parsed.iloc[0]["Preiseinheit (PDF)"] == 100


def test_repeated_article_unit_uses_quantity_weighted_price() -> None:
    frame = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Quelle": "staffeln.pdf",
                "PDF_Order": 2,
                "Preis": 20.0,
                "Menge": 1.0,
                "Einheit (PDF)": "Meter",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            },
            {
                "Artikelnummer": "6047611",
                "Quelle": "staffeln.pdf",
                "PDF_Order": 1,
                "Preis": 10.0,
                "Menge": 2.0,
                "Einheit (PDF)": "Meter",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            },
        ]
    )

    result = _aggregate_parsed_positions(frame)

    assert len(result) == 1
    assert result.iloc[0]["Menge"] == pytest.approx(3.0)
    assert result.iloc[0]["Preis"] == pytest.approx(40.0 / 3.0)
    assert result.iloc[0]["PDF_Order"] == 1


def test_missing_quantities_stay_missing_and_zero_quantities_stay_zero() -> None:
    frame = pd.DataFrame(
        [
            {
                "Artikelnummer": article,
                "Quelle": "mengen.pdf",
                "PDF_Order": order,
                "Preis": price,
                "Menge": quantity,
                "Einheit (PDF)": "Stück",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            }
            for article, order, price, quantity in (
                ("1000001", 1, 5.0, None),
                ("1000002", 2, 0.0, 0.0),
            )
        ]
    )

    result = _aggregate_parsed_positions(frame).set_index("Artikelnummer")

    assert pd.isna(result.loc["1000001", "Menge"])
    assert result.loc["1000001", "Preis"] == pytest.approx(5.0)
    assert result.loc["1000002", "Menge"] == 0.0
    assert result.loc["1000002", "Preis"] == 0.0


def test_different_prices_without_all_quantities_remain_separate() -> None:
    frame = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Quelle": "unweighted.pdf",
                "PDF_Order": 1,
                "Preis": 10.0,
                "Menge": 2.0,
                "Einheit (PDF)": "Meter",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            },
            {
                "Artikelnummer": "6047611",
                "Quelle": "unweighted.pdf",
                "PDF_Order": 2,
                "Preis": 20.0,
                "Menge": None,
                "Einheit (PDF)": "Meter",
                "Preiseinheit (PDF)": 1,
                "Preis_validiert": True,
            },
        ]
    )

    result = _aggregate_parsed_positions(frame).sort_values("PDF_Order")

    assert len(result) == 2
    assert result["Preis"].tolist() == [10.0, 20.0]
    assert result.iloc[0]["Menge"] == pytest.approx(2.0)
    assert pd.isna(result.iloc[1]["Menge"])
    assert result["Preis_validiert"].astype(bool).all()
