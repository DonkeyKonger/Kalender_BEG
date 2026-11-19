"""Byte-for-byte compatible exports from the original BEG price viewer.

The formatting and field mappings in this module intentionally stay close to
the original Streamlit implementation.  The only material adaptation is that
request-specific data is passed explicitly instead of being read from
``st.session_state``, module globals, or ``__main__``.
"""

from __future__ import annotations

import io
import re
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

try:
    from app.services.price_comparison_core import clean_artnr
except ImportError:  # Keep the export module usable while the core is installed independently.

    def clean_artnr(value: object) -> str:
        """Normalize an article number exactly like the original viewer."""

        normalized = re.sub(r"[^0-9A-Za-z]", "", str(value)).upper()
        return normalized.lstrip("0")


SOURCE_PROVENANCE = {
    "repository_commit": "4ed988fdb49a4db355d7c2361dbcf8e272ae563d",
    "offer_excel_and_pn_source": "viewer.py",
    "offer_excel_function": "_df_to_excel_download",
    "pn_function": "export_pn_ugl",
    "datanorm_excel_source": "tab1_datanorm_view.py:_df_to_xlsx_bytes",
    "article_csv_source": "article_view.py (ap_view.to_csv(index=False))",
}

EXCEL_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CSV_MIME_TYPE = "text/csv"
PN_UGL_MIME_TYPE = "application/octet-stream"


def dataframe_to_excel_download(
    df: pd.DataFrame,
    sheet_name: str = "Angebot",
    title: str | None = None,
    subtitle: str | None = None,
) -> tuple[bytes, str, str]:
    """Return the original formatted offer-workbook payload and download metadata."""

    # 1) bevorzugt: openpyxl -> .xlsx (mit Formatierung)
    try:
        import openpyxl  # noqa: F401
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter

        buf = io.BytesIO()

        # Wir reservieren 2 Zeilen fuer Titel/Subtitel, dann kommt der Header
        startrow = 2  # 0-based; Header landet damit in Excel-Zeile 3

        # --- Excel-only Bezeichnung einzeilig (Zeilenumbrueche entfernen) ---
        df = df.copy()
        # --- Excel-only: Platzhalter-Zeilen ("—", "-", "–" usw.) entfernen ---
        df = df.copy()

        def _is_placeholder_dash(value: object) -> bool:
            text = "" if value is None else str(value)

            # unsichtbare Whitespaces normalisieren
            text = text.replace("\u00a0", " ").replace("\u202f", " ").replace("\u2007", " ")
            text = text.strip()
            if not text:
                return False

            # verschiedene Dash-Zeichen auf "-" normalisieren
            text = text.replace("—", "-").replace("–", "-").replace("−", "-").replace("‒", "-")

            # wenn danach nur Striche uebrig sind -> Platzhalter
            return bool(re.fullmatch(r"-+", text))

        mask_drop = pd.Series(False, index=df.index)

        # OBO-Platzhalter tauchen typischerweise in Kurzbezeichnung/Bezeichnung auf
        if "Kurzbezeichnung" in df.columns:
            mask_drop |= df["Kurzbezeichnung"].map(_is_placeholder_dash)
        if "Bezeichnung" in df.columns:
            mask_drop |= df["Bezeichnung"].map(_is_placeholder_dash)
        # optional: falls Artikelnummer auch als Strich kommt
        if "Artikelnummer" in df.columns:
            mask_drop |= df["Artikelnummer"].map(_is_placeholder_dash)

        df = df.loc[~mask_drop].copy()

        # --- Excel-only Bezeichnung einzeilig (Zeilenumbrueche entfernen) ---
        if "Bezeichnung" in df.columns:
            df["Bezeichnung"] = (
                df["Bezeichnung"]
                .astype(str)
                .str.replace(r"\s*\n\s*", " ", regex=True)
                .str.replace(r"\s{2,}", " ", regex=True)
                .str.strip()
            )

        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name=sheet_name, startrow=startrow)

            ws = writer.sheets[sheet_name]

            ncols = max(1, len(df.columns))
            last_col = get_column_letter(ncols)

            # --- Titel / Subtitle (optional) ---
            if title:
                ws.merge_cells(f"A1:{last_col}1")
                cell = ws["A1"]
                cell.value = str(title)

                # --- Headerband Titel ---
                title_fill = PatternFill(
                    fill_type="solid", start_color="FF1E3A8A", end_color="FF1E3A8A"
                )
                cell.fill = title_fill
                cell.font = Font(bold=True, size=16, color="FFFFFFFF")
                cell.alignment = Alignment(horizontal="left", vertical="center")

                # Band ueber die ganze Zeile einfaerben
                for col_idx in range(1, ncols + 1):
                    ws.cell(row=1, column=col_idx).fill = title_fill

                ws.row_dimensions[1].height = 32

            if subtitle:
                ws.merge_cells(f"A2:{last_col}2")
                cell = ws["A2"]
                cell.value = str(subtitle)

                # --- Subheaderband ---
                sub_fill = PatternFill(
                    fill_type="solid", start_color="FFF3F4F6", end_color="FFF3F4F6"
                )
                cell.fill = sub_fill
                cell.font = Font(bold=False, size=11, color="FF374151")
                cell.alignment = Alignment(horizontal="left", vertical="center")

                # Band ueber die ganze Zeile einfaerben
                for col_idx in range(1, ncols + 1):
                    ws.cell(row=2, column=col_idx).fill = sub_fill

                ws.row_dimensions[2].height = 24

            # --- Header-Formatierung (Zeile 3) ---
            header_row = startrow + 1  # Excel 1-based
            # --- Excel-only: Preisvergleich-Emojis -> farbiger Punkt (Windows-kompatibel) ---
            try:
                if "Preisvergleich" in df.columns:
                    pv_col_idx = list(df.columns).index("Preisvergleich") + 1  # 1-based
                    pv_row_start = header_row + 1
                    pv_row_end = header_row + len(df)

                    # Farben (ARGB): "FF" + RRGGBB
                    color_red = "FFDC2626"
                    color_orange = "FFF59E0B"
                    color_yellow = "FFEAB308"
                    color_green = "FF16A34A"

                    for row_idx in range(pv_row_start, pv_row_end + 1):
                        cell = ws.cell(row=row_idx, column=pv_col_idx)
                        value = str(cell.value or "").strip()

                        if not value or value in ("—", "None", "nan"):
                            cell.value = ""
                            continue

                        # Emoji -> Punkt + Farbe (nur Excel)
                        if "🔴" in value:
                            cell.value = "●"
                            cell.font = Font(name="Segoe UI Symbol", color=color_red, bold=True)
                        elif "🟠" in value:
                            cell.value = "●"
                            cell.font = Font(name="Segoe UI Symbol", color=color_orange, bold=True)
                        elif "🟡" in value:
                            cell.value = "●"
                            cell.font = Font(name="Segoe UI Symbol", color=color_yellow, bold=True)
                        elif "🟢🟢" in value:
                            cell.value = "●●"
                            cell.font = Font(name="Segoe UI Symbol", color=color_green, bold=True)
                        elif "🟢" in value:
                            cell.value = "●"
                            cell.font = Font(name="Segoe UI Symbol", color=color_green, bold=True)

                        cell.alignment = Alignment(horizontal="center", vertical="center")
            except Exception:
                pass

            header_fill = PatternFill("solid", fgColor="F2F2F2")
            for col_idx in range(1, ncols + 1):
                cell = ws.cell(row=header_row, column=col_idx)
                cell.font = Font(bold=True)
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

            ws.row_dimensions[header_row].height = 25

            # --- Freeze Panes: alles oberhalb der Datenzeile fixieren ---
            ws.freeze_panes = f"A{header_row + 1}"

            # --- Autofilter ---
            last_row = header_row + len(df)

            # --- Zeilenhoehe: Standard 20 (statt Excel-Default 15) ---
            for row_idx in range(header_row, last_row + 1):
                ws.row_dimensions[row_idx].height = 22

            ws.auto_filter.ref = f"A{header_row}:{last_col}{last_row}"

            # --- Tabellen-Design (Header + feine Grid-Linien) ---
            grid_side = Side(style="thin", color="FFE5E7EB")
            grid_border = Border(left=grid_side, right=grid_side, top=grid_side, bottom=grid_side)

            header_fill = PatternFill(
                fill_type="solid", start_color="FFF3F4F6", end_color="FFF3F4F6"
            )
            header_font = Font(bold=True, size=10)

            for row_idx in range(header_row, last_row + 1):
                is_header = row_idx == header_row

                for col_idx in range(1, ncols + 1):
                    cell = ws.cell(row=row_idx, column=col_idx)

                    # Rahmen ueberall
                    cell.border = grid_border

                    # --- Bezeichnung nicht umbrechen lassen ---
                    col_name = df.columns[col_idx - 1]
                    if col_name == "Bezeichnung":
                        cell.alignment = Alignment(vertical="center", wrap_text=False)
                    else:
                        cell.alignment = Alignment(vertical="center", wrap_text=True)

                    # Header Styling
                    if is_header:
                        cell.fill = header_fill
                        cell.font = header_font
                        if col_name == "Bezeichnung":
                            cell.alignment = Alignment(
                                horizontal="left", vertical="center", wrap_text=False
                            )
                        else:
                            cell.alignment = Alignment(
                                horizontal="left", vertical="center", wrap_text=True
                            )

            # --- Spaltenbreiten + Zahlenformat + dezentes Highlight fuer "Preis" ---
            fixed_widths = {
                "Menge": 12,
                "Nettopreis": 12,
                "Preis": 12,
                "Preis_min": 12,
                "Preis_max": 12,
                "Preisvergleich": 12,
                "Aktueller Nettopreis": 15,
                "Medianangebotspreis": 18,
                "Vorschlag Nettopreis": 18,
            }

            # Styles fuer "Preis": nur vertikale Linien, kein Hintergrund
            preis_side = Side(style="thin", color="A9C7E6")
            preis_border = Border(left=preis_side, right=preis_side)
            vorschlag_fill = PatternFill(
                fill_type="solid", start_color="FFE6F4F1", end_color="FFE6F4F1"
            )
            vorschlag_header_fill = PatternFill(
                fill_type="solid", start_color="FFCCFBF1", end_color="FFCCFBF1"
            )
            vorschlag_side = Side(style="thin", color="FF14B8A6")
            vorschlag_border = Border(left=vorschlag_side, right=vorschlag_side)

            for col_idx, col_name in enumerate(df.columns, start=1):
                col_letter = get_column_letter(col_idx)

                # (1) Breite: feste 12 fuer deine Spalten, sonst Auto
                if col_name in fixed_widths:
                    ws.column_dimensions[col_letter].width = fixed_widths[col_name]
                else:
                    try:
                        max_len = max(
                            [len(str(col_name))]
                            + [
                                len(str(value))
                                for value in df[col_name].head(200).fillna("").astype(str).tolist()
                            ]
                        )
                    except Exception:
                        max_len = len(str(col_name))
                    ws.column_dimensions[col_letter].width = min(max(10, max_len + 2), 60)

                # (2) Zahlenformat bei numerischen Spalten
                try:
                    if pd.api.types.is_numeric_dtype(df[col_name]):
                        for row_idx in range(header_row + 1, last_row + 1):
                            ws.cell(row=row_idx, column=col_idx).number_format = "0.00"
                except Exception:
                    pass

                # --- Preisvergleich zentrieren (Excel-only) ---
                if col_name == "Preisvergleich":
                    ws.cell(row=header_row, column=col_idx).alignment = Alignment(
                        horizontal="center", vertical="center"
                    )

                    for row_idx in range(header_row + 1, last_row + 1):
                        ws.cell(row=row_idx, column=col_idx).alignment = Alignment(
                            horizontal="center", vertical="center"
                        )

                # (3) Highlight nur fuer "Preis": Header + feine Borders
                if col_name == "Preis":
                    header_cell = ws.cell(row=header_row, column=col_idx)
                    header_cell.border = preis_border

                    for row_idx in range(header_row + 1, last_row + 1):
                        ws.cell(row=row_idx, column=col_idx).border = preis_border

                if col_name == "Vorschlag Nettopreis":
                    header_cell = ws.cell(row=header_row, column=col_idx)
                    header_cell.fill = vorschlag_header_fill
                    header_cell.border = vorschlag_border
                    for row_idx in range(header_row + 1, last_row + 1):
                        cell = ws.cell(row=row_idx, column=col_idx)
                        cell.fill = vorschlag_fill
                        cell.border = vorschlag_border

        return buf.getvalue(), ".xlsx", EXCEL_MIME_TYPE

    except ModuleNotFoundError:
        pass
    except Exception:
        pass

    # 2) Fallback: xlsxwriter -> .xlsx (ohne Extra-Formatierung)
    try:
        import xlsxwriter  # noqa: F401

        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
            df.to_excel(writer, index=False, sheet_name=sheet_name)
        return buf.getvalue(), ".xlsx", EXCEL_MIME_TYPE
    except ModuleNotFoundError:
        pass
    except Exception:
        pass

    # 3) Letzter Fallback: CSV -> .csv
    return df.to_csv(index=False).encode("utf-8"), ".csv", CSV_MIME_TYPE


# Original private name retained for integration code copied from the viewer.
_df_to_excel_download = dataframe_to_excel_download


def datanorm_to_xlsx_bytes(df: pd.DataFrame) -> bytes:
    """Create the original plain Datanorm workbook payload."""

    export_df = df.copy()

    if "Bezeichnung" in export_df.columns:
        export_df["Bezeichnung"] = (
            export_df["Bezeichnung"]
            .astype(str)
            .str.replace(r"\s*\n\s*", " ", regex=True)
            .str.replace(r"\s{2,}", " ", regex=True)
            .str.strip()
        )

    buf = io.BytesIO()

    try:
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            export_df.to_excel(writer, index=False, sheet_name="Datanorm")
    except Exception:
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
            export_df.to_excel(writer, index=False, sheet_name="Datanorm")

    return buf.getvalue()


_df_to_xlsx_bytes = datanorm_to_xlsx_bytes


def article_offers_to_csv_bytes(ap_view: pd.DataFrame) -> bytes:
    """Return the article-view CSV bytes exactly as the original download did."""

    return ap_view.to_csv(index=False).encode("utf-8")


# =========================
# PN Handwerk Export (UGL 5.0 / Fixed-Width 350)
# =========================
_PN_KUNDENNR_RE = re.compile(r"Kunden-?Nr\.\s*:\s*([0-9]{1,10})", flags=re.IGNORECASE)
_PN_PROJEKTNR_RE = re.compile(r"Projekt-?Nr\.\s*:\s*([0-9A-Za-z\-/]{1,30})", flags=re.IGNORECASE)
_PROJ_REGEX = re.compile(
    r"Projekt[- ]?name\s*:\s*(.+?)(?=\s+Angebot\b|$)",
    flags=re.IGNORECASE | re.DOTALL,
)


def _pn_pad_fixed(value: str, length: int, align: str = "left", pad: str = " ") -> str:
    text = "" if value is None else str(value)
    if len(text) > length:
        text = text[:length]
    if align == "right":
        return text.rjust(length, pad)
    return text.ljust(length, pad)


def _pn_write_field(
    buf: list[str],
    start_1: int,
    length: int,
    value: str,
    align: str = "left",
    pad: str = " ",
) -> None:
    """Write a field into a 350-character line (``start_1`` is one-based)."""

    text = _pn_pad_fixed(value, length, align=align, pad=pad)
    start0 = start_1 - 1
    for index, character in enumerate(text):
        if 0 <= start0 + index < len(buf):
            buf[start0 + index] = character


def _pn_make_line_350() -> list[str]:
    return [" "] * 350


def _pn_line_to_str(line: list[str]) -> str:
    if len(line) != 350:
        line = (line + [" "] * 350)[:350]
    return "".join(line)


def _read_pdf_source(
    source: object,
    reader: Callable[[object], bytes] | None,
) -> bytes | None:
    """Resolve explicit PDF bytes without any application or session globals."""

    try:
        if source is None:
            return None
        if isinstance(source, bytes):
            return source
        if isinstance(source, (bytearray, memoryview)):
            return bytes(source)
        if reader is not None:
            return bytes(reader(source))
        if isinstance(source, (str, Path)):
            path = Path(source)
            return path.read_bytes() if path.exists() else None
        read = getattr(source, "read", None)
        if callable(read):
            raw = read()
            return bytes(raw) if raw is not None else None
    except Exception:
        return None
    return None


def _extract_first_page_text(pdf_bytes: bytes | None) -> str:
    if not pdf_bytes:
        return ""
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                return ""
            return pdf.pages[0].extract_text() or ""
    except Exception:
        return ""


def _pn_extract_kundennr_from_text(text: str) -> str | None:
    text = text.replace("\u00a0", " ").replace("\uf0b7", " ")
    match = _PN_KUNDENNR_RE.search(text)
    if not match:
        return None
    raw = re.sub(r"[^0-9]", "", match.group(1) or "")
    if not raw:
        return None
    return raw[:10]


def _pn_extract_projektnr_from_text(text: str) -> str | None:
    text = text.replace("\u00a0", " ").replace("\uf0b7", " ")
    match = _PN_PROJEKTNR_RE.search(text)
    if not match:
        return None
    raw = (match.group(1) or "").strip()
    raw = re.sub(r"\s{2,}", " ", raw)
    return raw[:15] if raw else None


def _extract_projectname_from_text(text: str) -> str | None:
    if not text:
        return None
    match = _PROJ_REGEX.search(text.replace("\u00a0", " ").replace("\uf0b7", " "))
    if not match:
        return None
    name = match.group(1).strip()
    name = re.sub(r"\s{2,}", " ", name)
    if name.lower().startswith("beg badener elektro gmbh"):
        return None
    return name or None


def _pn_int_scaled(value: object, decimals: int) -> int:
    """Scale a number to the fixed-width integer representation."""

    try:
        if pd.isna(value):
            return 0
    except Exception:
        pass
    try:
        decimal = Decimal(str(value).replace(",", "."))
    except Exception:
        return 0
    scale = Decimal(10) ** decimals
    return int((decimal * scale).quantize(Decimal("1"), rounding="ROUND_HALF_UP"))


def _pn_clean_artnr_for_pn(value: object) -> str:
    article = clean_artnr(str(value or ""))
    return article.lstrip("0")


def _pn_unit_code(value: object) -> str:
    """Normalize units to the original three-character PN/UGL codes."""

    text = "" if value is None else str(value).strip()
    if not text:
        return "st "

    lowered = text.lower().replace(".", "")

    if lowered in {"m", "meter", "lfm", "laufmeter", "mtr"}:
        return "m  "

    if lowered in {"st", "stk", "stück", "stueck", "piece", "pcs"}:
        return "st "

    if len(text) == 3:
        return text

    return "st "


def _pn_extract_kuerzel_from_text(text: object) -> str:
    """Extract the OBO-style short article designation used by the original viewer."""

    value = "" if text is None else str(text)
    raw_lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [re.sub(r"\s+", " ", line).strip() for line in raw_lines]
    lines = [line for line in lines if line]

    if not lines:
        return ""

    def _is_noise_line(line: str) -> bool:
        lowered = line.lower()
        if lowered.startswith("gewicht"):
            return True
        if "dimension" in lowered or "dimensio" in lowered:
            return True
        return "farbe" in lowered

    def _score_line(line: str) -> int:
        lowered = line.lower()
        score = 0

        if re.search(r"[A-Za-z]", line) and re.search(r"\d", line):
            score += 3
        if re.search(r"\b(FS|FT|VS|R1|R2|R3|LG|RB|LB|RAA|TSG|TS)\b", line):
            score += 3
        if ":" in line:
            score -= 3
        if " für " in f" {lowered} ":
            score -= 1
        if len(line) > 45:
            score -= 2

        return score

    candidates = [line for line in lines if not _is_noise_line(line)]
    if not candidates:
        candidates = lines

    best = max(candidates, key=_score_line)
    match = re.search(r"\s+für\s+", best, flags=re.IGNORECASE)
    if match:
        best = best[: match.start()].strip()

    return re.sub(r"\s+", " ", best).strip()


def export_pn_ugl(
    df: pd.DataFrame,
    pdf_source: object = None,
    projekt_text: str = "",
    angebot_ref: str = "",
    *,
    datanorm_df: pd.DataFrame | None = None,
    pdf_bytes_reader: Callable[[object], bytes] | None = None,
) -> tuple[bytes, str, str]:
    """Create the original UGL 5.0 order (350 CP850 bytes per CRLF line).

    ``pdf_source`` may be raw bytes, a local path, a binary file object, or an
    application-owned identifier resolved by ``pdf_bytes_reader``.
    """

    # Defaults (ohne UI): Dokumentdatum heute, Lieferdatum +7 Tage
    today = pd.Timestamp.now(tz=None).strftime("%Y%m%d")
    lieferdatum = (pd.Timestamp.now(tz=None) + pd.Timedelta(days=7)).strftime("%Y%m%d")

    pdf_bytes = _read_pdf_source(pdf_source, pdf_bytes_reader)
    pdf_text = _extract_first_page_text(pdf_bytes)

    kundennr = _pn_extract_kundennr_from_text(pdf_text) if pdf_text else None
    vorgang = _pn_extract_projektnr_from_text(pdf_text) if pdf_text else None
    vorgang = (vorgang or angebot_ref or "")[:15]

    # PN/Access-sicher: Projekttext staerker begrenzen
    projekt_text = "" if projekt_text is None else str(projekt_text)
    projekt_text = projekt_text.replace("\r", " ").replace("\n", " ").strip()
    projekt_text = projekt_text[:30]

    # Projekttext automatisch aus PDF ziehen, falls leer
    if not projekt_text and pdf_text:
        projekt_text = _extract_projectname_from_text(pdf_text) or ""

    # KOP-Felder fuer PN bestmoeglich befuellen
    angebot_ref = (angebot_ref or "").strip()

    # 41-90 (50): gut lesbar fuer PN (Projektname + Angebotsnr)
    kundenauftragstext = " / ".join(
        [part for part in [angebot_ref, projekt_text.strip()] if part]
    ).strip()
    kundenauftragstext = kundenauftragstext.replace("\r", " ").replace("\n", " ").strip()

    lines: list[str] = []

    # --- KOP ---
    kop = _pn_make_line_350()
    _pn_write_field(kop, 1, 3, "KOP")
    _pn_write_field(kop, 4, 10, kundennr, align="left", pad=" ")
    # 14-23: Lieferantennr absichtlich leer
    _pn_write_field(kop, 24, 2, "BE")
    _pn_write_field(kop, 26, 15, vorgang, align="left", pad=" ")
    _pn_write_field(kop, 41, 50, kundenauftragstext, align="left", pad=" ")
    _pn_write_field(kop, 106, 8, lieferdatum, align="right", pad="0")
    _pn_write_field(kop, 114, 3, "EUR")
    _pn_write_field(kop, 117, 5, "05.00")
    _pn_write_field(kop, 162, 8, today, align="right", pad="0")
    lines.append(_pn_line_to_str(kop))

    # --- POA ---
    tmp = df.copy() if df is not None else pd.DataFrame()

    for col in ["Artikelnummer", "Bezeichnung", "Menge", "Preis"]:
        if col not in tmp.columns:
            tmp[col] = pd.NA

    tmp["Artikelnummer"] = tmp["Artikelnummer"].astype(str)
    tmp["Bezeichnung"] = tmp["Bezeichnung"].astype(str).fillna("")
    tmp["Menge"] = pd.to_numeric(tmp["Menge"], errors="coerce").fillna(0.0)
    tmp["Preis"] = pd.to_numeric(tmp["Preis"], errors="coerce").fillna(0.0)

    tmp["_bez_norm"] = (
        tmp["Bezeichnung"].astype(str).str.replace(r"\s+", " ", regex=True).str.strip()
    )
    tmp["_art_pn"] = tmp["Artikelnummer"].map(_pn_clean_artnr_for_pn).astype(str).str.strip()

    tmp = tmp[(~tmp["_bez_norm"].isin({"?", "", "—", "-"})) & (tmp["_art_pn"].str.len() > 0)].copy()

    tmp["_art_sort"] = pd.to_numeric(tmp["_art_pn"], errors="coerce")
    tmp = tmp.sort_values(by="_art_sort", ascending=True, na_position="last")

    # Einheit-Fallback aus Datanorm; formerly read from the viewer's ``df_dn`` global.
    dn_unit_map: dict[str, str] = {}
    try:
        if isinstance(datanorm_df, pd.DataFrame) and not datanorm_df.empty:
            if "Artikelnummer" in datanorm_df.columns and "Einheit" in datanorm_df.columns:
                for row in datanorm_df[["Artikelnummer", "Einheit"]].itertuples(index=False):
                    key = _pn_clean_artnr_for_pn(getattr(row, "Artikelnummer", ""))
                    value = getattr(row, "Einheit", "")
                    if key and value:
                        dn_unit_map[key] = str(value).strip()
    except Exception:
        dn_unit_map = {}

    def _pn_first_two_project_words(value: object) -> str:
        text = "" if value is None else str(value)
        text = text.replace("\r", " ").replace("\n", " ")
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return ""
        return " ".join(text.split(" ")[:2]).strip()

    angebot_ref_short = re.sub(r"\s+", " ", str(angebot_ref or "")).strip()
    projekt_short = _pn_first_two_project_words(projekt_text)
    pn_suffix_parts = [part for part in [angebot_ref_short, projekt_short] if part]
    pn_bez_suffix = f"({' - '.join(pn_suffix_parts)})" if pn_suffix_parts else ""

    for index, row in tmp.reset_index(drop=True).iterrows():
        posnr = str(index + 1).zfill(10)

        article = _pn_clean_artnr_for_pn(row.get("Artikelnummer"))
        article = _pn_pad_fixed(article, 15, align="left", pad=" ")

        # Keep original scaling: quantity x1000, price x100.
        qty_int = _pn_int_scaled(row.get("Menge"), decimals=3)
        price_int = _pn_int_scaled(row.get("Preis"), decimals=2)

        try:
            qty = Decimal(str(row.get("Menge", 0)).replace(",", "."))
            price = Decimal(str(row.get("Preis", 0)).replace(",", "."))
            net_int = int(
                (price * qty * Decimal(100)).quantize(Decimal("1"), rounding="ROUND_HALF_UP")
            )
        except Exception:
            net_int = 0

        colmap = {str(column).strip().lower(): column for column in tmp.columns}
        designation_source = None
        for key in [
            "kurzbezeichnung",
            "kürzel",
            "kuerzel",
            "artikelkürzel",
            "artikelkuerzel",
            "typ",
            "type",
            "kurzbez",
            "kurztext",
        ]:
            if key in colmap:
                designation_source = colmap[key]
                break

        designation_raw = (
            str(row.get(designation_source) or "").strip() if designation_source else ""
        )
        if not designation_raw:
            designation_raw = _pn_extract_kuerzel_from_text(row.get("Bezeichnung"))
        if not designation_raw:
            designation_raw = str(row.get("Bezeichnung") or "")

        designation = re.sub(r"\s+", " ", str(designation_raw or "")).strip()
        bez1 = designation[:40]
        bez2 = pn_bez_suffix[:40] if pn_bez_suffix else ""

        poa = _pn_make_line_350()
        _pn_write_field(poa, 1, 3, "POA")
        _pn_write_field(poa, 4, 10, posnr, align="right", pad="0")
        _pn_write_field(poa, 14, 10, "0000000000", align="right", pad="0")
        _pn_write_field(poa, 24, 15, article, align="left", pad=" ")
        _pn_write_field(poa, 39, 11, str(max(0, int(qty_int))), align="right", pad="0")
        _pn_write_field(poa, 50, 40, bez1, align="left", pad=" ")
        _pn_write_field(poa, 90, 40, bez2, align="left", pad=" ")
        _pn_write_field(poa, 130, 11, str(max(0, int(price_int))), align="right", pad="0")
        _pn_write_field(poa, 141, 1, "0")
        _pn_write_field(poa, 142, 11, str(max(0, int(net_int))), align="right", pad="0")
        _pn_write_field(poa, 153, 5, "00000", align="right", pad="0")
        _pn_write_field(poa, 158, 5, "00000", align="right", pad="0")

        unit_value: Any = None
        if "Einheit" in tmp.columns:
            unit_value = row.get("Einheit")
        if unit_value is None or str(unit_value).strip() == "":
            unit_value = dn_unit_map.get(_pn_clean_artnr_for_pn(row.get("Artikelnummer")))
        _pn_write_field(poa, 184, 3, _pn_unit_code(unit_value))

        _pn_write_field(poa, 187, 1, "2")
        _pn_write_field(poa, 188, 1, "B")
        _pn_write_field(poa, 189, 5, "01900", align="right", pad="0")

        lines.append(_pn_line_to_str(poa))

    # --- END ---
    end = _pn_make_line_350()
    _pn_write_field(end, 1, 3, "END")
    lines.append(_pn_line_to_str(end))

    content = "\r\n".join(lines) + "\r\n"
    data = content.encode("cp850", errors="replace")

    # Dateiname: Projektname + Angebotsnummer
    project_filename = re.sub(r"[^\w\-\s]", "", str(projekt_text or "")).strip()
    offer_filename = re.sub(r"[^\w\-\s]", "", str(angebot_ref or "")).strip()
    project_filename = re.sub(r"\s+", "_", project_filename)
    offer_filename = re.sub(r"\s+", "_", offer_filename)

    if project_filename and offer_filename:
        filename = f"{project_filename}_{offer_filename}"
    elif project_filename:
        filename = project_filename
    elif offer_filename:
        filename = offer_filename
    else:
        filename = "PN_Bestellung"

    return data, filename, PN_UGL_MIME_TYPE


from app.services.price_comparison_pdf_export import (  # noqa: E402
    build_article_pdf_bytes,
    build_offer_compilation_pdf,
)

_build_article_pdf_bytes = build_article_pdf_bytes
_build_offer_compilation_pdf = build_offer_compilation_pdf


__all__ = [
    "CSV_MIME_TYPE",
    "EXCEL_MIME_TYPE",
    "PN_UGL_MIME_TYPE",
    "SOURCE_PROVENANCE",
    "article_offers_to_csv_bytes",
    "build_article_pdf_bytes",
    "build_offer_compilation_pdf",
    "dataframe_to_excel_download",
    "datanorm_to_xlsx_bytes",
    "export_pn_ugl",
]
