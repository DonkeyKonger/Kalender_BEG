from __future__ import annotations

import ast
import io
import os
import re
from decimal import Decimal
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook
from pypdf import PdfReader
from reportlab.pdfgen import canvas

from app.services.price_comparison_exports import (
    CSV_MIME_TYPE,
    EXCEL_MIME_TYPE,
    PN_UGL_MIME_TYPE,
    article_offers_to_csv_bytes,
    dataframe_to_excel_download,
    datanorm_to_xlsx_bytes,
    export_pn_ugl,
)
from app.services.price_comparison_pdf_export import (
    build_article_pdf_bytes,
    build_offer_compilation_pdf,
)


FROZEN_VIEWER_REFERENCE = (
    Path(__file__).parent / "fixtures" / "priceviewer_reference" / "viewer_exports_reference.py"
)
ORIGINAL_VIEWER = Path(os.environ.get("BEG_PRICEVIEWER_ORIGINAL_VIEWER", FROZEN_VIEWER_REFERENCE))


def _metadata_pdf_bytes() -> bytes:
    out = io.BytesIO()
    pdf = canvas.Canvas(out)
    pdf.drawString(40, 800, "Kunden-Nr.: 615099")
    pdf.drawString(40, 780, "Projekt-Nr.: PR-42/7")
    pdf.drawString(40, 760, "Projektname: Übersee Werk Nord Angebot 3261061")
    pdf.save()
    return out.getvalue()


def _original_ugl_namespace() -> dict[str, object]:
    """Load only the original pure UGL functions, never the Streamlit module body."""

    if not ORIGINAL_VIEWER.is_file():
        raise AssertionError(f"Frozen Preisviewer reference is missing: {ORIGINAL_VIEWER}")

    source = ORIGINAL_VIEWER.read_text(encoding="utf-8")
    parsed = ast.parse(source, filename=str(ORIGINAL_VIEWER))
    names = {
        "clean_artnr",
        "_extract_projectname_from_text",
        "_extract_projectname_from_pdf",
        "_pn_pad_fixed",
        "_pn_write_field",
        "_pn_make_line_350",
        "_pn_line_to_str",
        "_pn_extract_kundennr_from_pdf",
        "_pn_extract_projektnr_from_pdf",
        "_pn_int_scaled",
        "_pn_clean_artnr_for_pn",
        "_pn_unit_code",
        "_pn_extract_kuerzel_from_text",
        "export_pn_ugl",
    }
    nodes = [
        node
        for node in parsed.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names
    ]
    module = ast.Module(body=nodes, type_ignores=[])
    ast.fix_missing_locations(module)

    namespace: dict[str, object] = {
        "Decimal": Decimal,
        "Path": Path,
        "io": io,
        "pd": pd,
        "re": re,
        "_PN_KUNDENNR_RE": re.compile(r"Kunden-?Nr\.\s*:\s*([0-9]{1,10})", flags=re.IGNORECASE),
        "_PN_PROJEKTNR_RE": re.compile(
            r"Projekt-?Nr\.\s*:\s*([0-9A-Za-z\-/]{1,30})", flags=re.IGNORECASE
        ),
        "_PROJ_REGEX": re.compile(
            r"Projekt[- ]?name\s*:\s*(.+?)(?=\s+Angebot\b|$)",
            flags=re.IGNORECASE | re.DOTALL,
        ),
    }

    def _storage_obj_exists(source: object) -> bool:
        return isinstance(source, (bytes, bytearray)) and bool(source)

    def _open_pdfplumber_from_storage(source: object):
        import pdfplumber

        return pdfplumber.open(io.BytesIO(bytes(source)))

    namespace["_storage_obj_exists"] = _storage_obj_exists
    namespace["_open_pdfplumber_from_storage"] = _open_pdfplumber_from_storage
    exec(compile(module, str(ORIGINAL_VIEWER), "exec"), namespace)
    return namespace


def test_pn_ugl_bytes_match_canonical_original_function() -> None:
    df = pd.DataFrame(
        [
            {
                "Artikelnummer": "000020",
                "Bezeichnung": "Gewicht: 4 kg\nLB 90 640 R3 FS\nfür Kabelleiter",
                "Kurzbezeichnung": "Kürzel Ü20",
                "Menge": 2.5,
                "Preis": 12.345,
                "Einheit": "",
            },
            {
                "Artikelnummer": "000003",
                "Bezeichnung": "TSG 110 FS\nDimension: 110 mm",
                "Kurzbezeichnung": "TSG 110 FS",
                "Menge": 1.25,
                "Preis": 9.995,
                "Einheit": "STK",
            },
            {
                "Artikelnummer": "000099",
                "Bezeichnung": "?",
                "Kurzbezeichnung": "ignored",
                "Menge": 4,
                "Preis": 1,
                "Einheit": "MTR",
            },
        ]
    )
    datanorm_df = pd.DataFrame([{"Artikelnummer": "000020", "Einheit": "MTR"}])
    pdf_bytes = _metadata_pdf_bytes()

    original = _original_ugl_namespace()
    original["df_dn"] = datanorm_df
    original_result = original["export_pn_ugl"](
        df,
        pdf_source=pdf_bytes,
        projekt_text="",
        angebot_ref="A-77",
    )
    adapted_result = export_pn_ugl(
        df,
        pdf_source=pdf_bytes,
        projekt_text="",
        angebot_ref="A-77",
        datanorm_df=datanorm_df,
    )

    assert adapted_result == original_result


def test_pn_ugl_has_cp850_fixed_width_crlf_records_and_metadata_callback() -> None:
    df = pd.DataFrame(
        [
            {
                "Artikelnummer": "00045-6",
                "Bezeichnung": "Gewicht: 1 kg\nLB 90 640 R3 FS\nfür Kabelleiter",
                "Menge": "61.83",
                "Preis": "10.25",
            }
        ]
    )
    calls: list[object] = []

    def reader(source: object) -> bytes:
        calls.append(source)
        return _metadata_pdf_bytes()

    data, filename, mime = export_pn_ugl(
        df,
        pdf_source="angebot-remote.pdf",
        projekt_text="",
        angebot_ref="3261061",
        datanorm_df=pd.DataFrame([{"Artikelnummer": "00045-6", "Einheit": "MTR"}]),
        pdf_bytes_reader=reader,
    )

    assert calls == ["angebot-remote.pdf"]
    assert filename == "Übersee_Werk_Nord_3261061"
    assert mime == PN_UGL_MIME_TYPE
    assert data.endswith(b"\r\n")
    assert b"\n" not in data.replace(b"\r\n", b"")

    records = data.removesuffix(b"\r\n").split(b"\r\n")
    assert [len(record) for record in records] == [350, 350, 350]
    assert [record[:3] for record in records] == [b"KOP", b"POA", b"END"]

    header = records[0].decode("cp850")
    position = records[1].decode("cp850")
    assert header[3:13].strip() == "615099"
    assert header[25:40].strip() == "PR-42/7"
    assert header[40:90].strip() == "3261061 / Übersee Werk Nord"
    assert position[3:13] == "0000000001"
    assert position[23:38].strip() == "456"
    assert position[38:49] == "00000061830"
    assert position[49:89].strip() == "LB 90 640 R3 FS"
    assert position[89:129].strip() == "(3261061 - Übersee Werk)"
    assert position[129:140] == "00000001025"
    assert position[183:186] == "m  "


def test_formatted_excel_matches_original_ooxml_semantics() -> None:
    df = pd.DataFrame(
        [
            {
                "Artikelnummer": "001",
                "Bezeichnung": "Kabelrinne\n200 mm",
                "Menge": 2.5,
                "Preis": 10.25,
                "Preisvergleich": "🟢🟢 günstig",
                "Vorschlag Nettopreis": 9.75,
            },
            {
                "Artikelnummer": "002",
                "Bezeichnung": "—",
                "Menge": 1,
                "Preis": 1,
                "Preisvergleich": "🔴 teuer",
                "Vorschlag Nettopreis": 1,
            },
        ]
    )

    payload, extension, mime = dataframe_to_excel_download(
        df,
        sheet_name="Angebot",
        title="Werk Nord | 3261061",
        subtitle="Lieferangebot",
    )

    assert extension == ".xlsx"
    assert mime == EXCEL_MIME_TYPE
    assert payload.startswith(b"PK")

    workbook = load_workbook(io.BytesIO(payload))
    sheet = workbook["Angebot"]
    assert sheet["A1"].value == "Werk Nord | 3261061"
    assert sheet["A2"].value == "Lieferangebot"
    assert str(sheet.merged_cells.ranges).find("A1:F1") >= 0
    assert str(sheet.merged_cells.ranges).find("A2:F2") >= 0
    assert [sheet.cell(3, column).value for column in range(1, 7)] == list(df.columns)
    assert sheet["A4"].value == "001"
    assert sheet["B4"].value == "Kabelrinne 200 mm"
    assert sheet.max_row == 4  # placeholder row was removed
    assert sheet.freeze_panes == "A4"
    assert sheet.auto_filter.ref == "A3:F4"
    assert sheet["E4"].value == "●●"
    assert sheet["E4"].font.color.rgb == "FF16A34A"
    assert sheet["C4"].number_format == "0.00"
    assert sheet.column_dimensions["C"].width == 12
    assert sheet.column_dimensions["D"].width == 12
    assert sheet.column_dimensions["E"].width == 12
    assert sheet.column_dimensions["F"].width == 18
    assert sheet["D4"].border.left.color.rgb == "00A9C7E6"
    assert sheet["F4"].fill.fgColor.rgb == "FFE6F4F1"


def test_datanorm_xlsx_and_article_csv_preserve_original_payloads() -> None:
    datanorm = pd.DataFrame(
        [
            {
                "Artikelnummer": "001",
                "Bezeichnung": "Kabelrinne\n 200 mm",
                "Einheit": "MTR",
                "Nettopreis": 12.5,
            }
        ]
    )
    xlsx = datanorm_to_xlsx_bytes(datanorm)
    workbook = load_workbook(io.BytesIO(xlsx), data_only=True)
    sheet = workbook["Datanorm"]
    assert [sheet.cell(1, column).value for column in range(1, 5)] == list(datanorm.columns)
    assert sheet["B2"].value == "Kabelrinne 200 mm"
    assert sheet["D2"].value == 12.5

    offers = pd.DataFrame([{"Monat": "2026-11", "Angebotspreis": 12.5, "Angebot": "A-77"}])
    csv_bytes = article_offers_to_csv_bytes(offers)
    assert csv_bytes == offers.to_csv(index=False).encode("utf-8")
    assert CSV_MIME_TYPE == "text/csv"


def _article_frames() -> tuple[pd.DataFrame, pd.DataFrame]:
    now = pd.Timestamp.now(tz=None).normalize()
    ap_view = pd.DataFrame(
        [
            {"Monat": "2026-11", "Angebotspreis": 12.5, "Angebot": "A-77"},
            {"Monat": "2026-10", "Angebotspreis": 13.0, "Angebot": "A-66"},
            {"Monat": "2026-09", "Angebotspreis": 11.75, "Angebot": "A-55"},
        ]
    )
    chart_data = pd.DataFrame(
        [
            {
                "Datum": now - pd.Timedelta(days=10),
                "Quelle": "A-77.pdf",
                "PDF_Order": 0,
                "Preis": 12.5,
                "DatumLabel": "11-26",
                "YMin": 5.0,
            },
            {
                "Datum": now - pd.Timedelta(days=40),
                "Quelle": "A-66.pdf",
                "PDF_Order": 0,
                "Preis": 13.0,
                "DatumLabel": "10-26",
                "YMin": 5.0,
            },
            {
                "Datum": now - pd.Timedelta(days=70),
                "Quelle": "A-55.pdf",
                "PDF_Order": 0,
                "Preis": 11.75,
                "DatumLabel": "09-26",
                "YMin": 5.0,
            },
        ]
    )
    return ap_view, chart_data


def test_article_pdf_generates_original_sections_text_and_pages() -> None:
    ap_view, chart_data = _article_frames()
    payload = build_article_pdf_bytes(
        art="12345",
        bez_lines=["Kabelrinne 200 mm", "SKSM 620 FT"],
        einheit="MTR",
        ap_view=ap_view,
        chart_data=chart_data,
        dn_val=12.25,
        highlight_src="A-77.pdf",
    )

    assert payload is not None and payload.startswith(b"%PDF")
    reader = PdfReader(io.BytesIO(payload))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert len(reader.pages) == 1
    assert "Preisvergleich" in text and "Artikel 12345" in text
    assert "Kabelrinne 200 mm" in text
    assert "Einheit: MTR" in text
    assert "Datanorm-Preis" in text
    assert "12,25 €" in text
    assert "A-77" in text
    assert "Balken-Diagramm" in text
    assert "Linien-Diagramm" in text


def test_offer_compilation_pdf_generates_filtered_article_page_without_global_context() -> None:
    now = pd.Timestamp.now(tz=None).normalize()
    all_prices = pd.DataFrame(
        [
            {
                "Artikelnummer": "0012345",
                "Quelle": "target.pdf",
                "Datum": now - pd.Timedelta(days=10),
                "PDF_Order": 0,
                "Preis": 12.5,
                "Angebot": "3261061",
                "Projekt": "Nexperia Süd",
            },
            {
                "Artikelnummer": "0012345",
                "Quelle": "other-1.pdf",
                "Datum": now - pd.Timedelta(days=40),
                "PDF_Order": 0,
                "Preis": 13.0,
                "Angebot": "3261001",
                "Projekt": "Nexperia Süd",
            },
            {
                "Artikelnummer": "0012345",
                "Quelle": "other-2.pdf",
                "Datum": now - pd.Timedelta(days=70),
                "PDF_Order": 0,
                "Preis": 11.75,
                "Angebot": "3260999",
                "Projekt": "Nexperia Süd",
            },
        ]
    )
    datanorm = pd.DataFrame(
        [
            {
                "Artikelnummer": "0012345",
                "Bezeichnung": "Kabelrinne 200 mm\nSKSM 620 FT\nMat.: Stahl",
                "Einheit": "MTR",
                "Nettopreis": 12.25,
            }
        ]
    )

    payload = build_offer_compilation_pdf("target.pdf", datanorm, all_prices)

    assert payload is not None and payload.startswith(b"%PDF")
    reader = PdfReader(io.BytesIO(payload))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert len(reader.pages) >= 1
    assert "Nexperia Süd" in text
    assert "SKSM 620 FT" in text
    assert "Kabelrinne 200 mm" in text
    assert "MTR" in text and "12345" in text
    assert "Datanorm-Preis" in text
    assert "3261061" in text
    assert "Balken-Diagramm" in text

    # A second request must not mutate the first request's page header.
    second_prices = all_prices.copy()
    second_prices["Projekt"] = "Werk Nord"
    second_payload = build_offer_compilation_pdf("target.pdf", datanorm, second_prices)
    assert second_payload is not None
    second_reader = PdfReader(io.BytesIO(second_payload))
    second_text = "\n".join(page.extract_text() or "" for page in second_reader.pages)
    first_text_again = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert "Werk Nord" in second_text
    assert "Werk Nord" not in first_text_again
    assert "Nexperia Süd" in first_text_again
