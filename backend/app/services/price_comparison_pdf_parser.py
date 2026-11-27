from __future__ import annotations


from collections import Counter
import re
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pdfplumber

# ==== Feste Projekt-Region (aus viewer.py übernommen) ====
PROJECT_REGION_NORM = (0.10, 0.18, 0.92, 0.27)
PROJECT_PAGE_INDEX = 0

# ==== Projektnamen sicher aus PDF-Kopf lesen ===================================

_PROJ_REGEX = re.compile(
    r"Projekt[- ]?name\s*:\s*(.+?)(?=\s+Angebot\b|$)",  # bis vor "Angebot ..." oder Zeilenende
    flags=re.IGNORECASE | re.DOTALL
)




# Regex/Heuristiken & Helfer
# =========================
PRICE_RE_DE  = re.compile(r"\b\d{1,3}(?:\.\d{3})*,\d{2}\b")
ARTNR_RE     = re.compile(r"\b\d{6,9}\b")
DATE_RE      = re.compile(r"\b\d{2}\.\d{2}\.\d{4}\b", re.ASCII)
SUM_ROW_PAT  = re.compile(r"(blocksumme|gesamt(?!\s*zzgl)|preis\s*pro\s*einheit|summe\b)", re.IGNORECASE)

# =========================
# Header-Synonyme für PDF-Tabellen
# =========================
HEADER_SYNONYMS = {
    "Artikelnummer": [
        "art.nr", "art. nr", "artikel", "artikelnummer", "artnr", "artikel-nr"
    ],
    "Bezeichnung": [
        "bezeichnung", "beschreibung", "text", "artikelbezeichnung", "produkt"
    ],
    "Menge": [
        "menge", "anzahl", "qty", "quantity", "stückzahl"
    ],
    "Einheit": [
        "einheit", "me", "eh", "unit"
    ],
    "Gesamt": [
        "gesamt", "summe", "gesamtpreis", "blocksumme"
    ],
    "Preis": [
        "preis", "betrag", "kosten", "netto", "brutto", "ep"
    ],
    # 🔥 NEU für OBO-Angebote:
    "Material": [
        "material", "mat."
    ],
    "per": [
        "per", "pro", "je"
    ],
}


def clean_artnr(artnr: str) -> str:
    s = re.sub(r"[^0-9A-Za-z]", "", str(artnr)).upper()
    return s.lstrip("0")

def smart_float(x):
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    m = PRICE_RE_DE.search(s)
    if m:
        return float(m.group(0).replace(".", "").replace(",", "."))
    s = re.sub(r"[^\d,.\-]", "", s)
    if s in {".", ",", "-"}:
        return None
    m2 = re.search(r"[.,](\d{1,2})\s*$", s)
    if m2:
        dec = s[m2.start(0)]
        keep = f"0-9{re.escape(dec)}"
        s2 = re.sub(fr"[^{keep}]", "", s)
        if dec == ",":
            s2 = s2.replace(",", ".")
        try:
            return float(s2)
        except Exception:
            return None
    s2 = re.sub(r"\D", "", s)
    if not s2:
        return None
    try:
        return float(s2)
    except Exception:
        return None


_PDF_NUMBER_DE = r"(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?"
_PDF_COMPACT_QTY_DE = r"(?:\d{1,3}(?:\.\d{3})+|\d+),\d+"
_PDF_MONEY_DE = r"(?:\d{1,3}(?:\.\d{3})+|\d+)[.,]\d{2}"
_PDF_UNIT = r"(?:Stück|Stueck|Stk\.?|STCK|Meter|Kilogramm?|Paar|VPE|lfm|mtr|MTR|kg|m)"
_PDF_TOTAL_CURRENCY = rf"{_PDF_MONEY_DE}\s+(?:EUR\b|€(?=\s|$))"
_PDF_QTY_UNIT_RE = re.compile(
    rf"(?<![\w.,+−-])(?P<qty>{_PDF_COMPACT_QTY_DE})\s*(?P<unit>{_PDF_UNIT})(?=\s|$)",
    flags=re.IGNORECASE,
)
_PDF_MATERIAL_PER_RE = re.compile(
    rf"^\s*(?P<material>{_PDF_MONEY_DE})\s+(?P<per>\d{{1,5}})"
    rf"(?=\s+(?:EUR\b|[A-Za-zÄÖÜäöüß]|{_PDF_TOTAL_CURRENCY})|\s*$)",
    flags=re.IGNORECASE,
)
_PDF_CURRENCY_MATERIAL_PER_RE = re.compile(
    rf"^\s*(?:EUR|€)\s*(?P<material>{_PDF_MONEY_DE})\s+(?P<per>\d{{1,5}})"
    rf"(?=\s+(?:[A-Za-zÄÖÜäöüß]|{_PDF_TOTAL_CURRENCY})|\s*$)",
    flags=re.IGNORECASE,
)
_PDF_UNPRICED_TOTAL_RE = re.compile(
    rf"^\s*(?:\S+\s+)?(?P<per>\d{{1,5}})\s+{_PDF_TOTAL_CURRENCY}",
    flags=re.IGNORECASE,
)
_PDF_PER_ONLY_RE = re.compile(
    r"^\s*(?P<per>\d{1,5})\s+EUR\b",
    flags=re.IGNORECASE,
)
_PDF_CURRENCY_ONLY_RE = re.compile(r"^\s*(?:EUR|€)\b", flags=re.IGNORECASE)
_PDF_UNIT_MATERIAL_PER_RE = re.compile(
    rf"(?<!\w)(?P<unit>{_PDF_UNIT})(?=\s)\s+"
    rf"(?P<material>{_PDF_MONEY_DE})\s+(?P<per>\d{{1,5}})\s+(?:EUR|€)\b",
    flags=re.IGNORECASE,
)
_PDF_UNIT_PER_ONLY_RE = re.compile(
    rf"(?P<unit>{_PDF_UNIT})(?=\s)\s+(?P<per>\d{{1,5}})\s+(?:EUR|€)\b",
    flags=re.IGNORECASE,
)
_PDF_ZERO_MATERIAL_PER_RE = re.compile(
    r"(?<![\d.,])(?P<material>0[.,]00)\s+(?P<per>\d{1,5})\s+(?:EUR|€)\b",
    flags=re.IGNORECASE,
)


def _normalize_pdf_unit(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    key = raw.casefold().rstrip(".")
    if key in {"stück", "stueck", "stk", "stck"}:
        return "Stück"
    if key in {"m", "meter", "lfm", "mtr"}:
        return "Meter"
    if key in {"kg", "kilogram", "kilogramm"}:
        return "Kilogramm"
    if key == "paar":
        return "Paar"
    if key == "vpe":
        return "VPE"
    return raw


def _validated_per(value: object) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if pd.notna(number) and number.is_integer() and 1 <= number <= 10000:
            return int(number)
        return None
    raw = str(value or "").strip()
    if not re.fullmatch(r"\d{1,5}", raw):
        return None
    result = int(raw)
    return result if 1 <= result <= 10000 else None


def _validated_money(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        result = float(value)
        return result if pd.notna(result) else None
    raw = re.sub(r"\s*(?:EUR|€)\s*$", "", str(value or "").strip(), flags=re.IGNORECASE)
    if not re.fullmatch(_PDF_MONEY_DE, raw):
        return None
    return smart_float(raw)


def _parse_obo_compact_line(line: object) -> dict | None:
    """Parse one merged OBO row without ever treating its quantity as material."""

    text = re.sub(r"\s+", " ", str(line or "")).strip()
    if not text or SUM_ROW_PAT.search(text):
        return None
    article_match = ARTNR_RE.search(text)
    if not article_match:
        return None

    article = clean_artnr(article_match.group(0))
    segments = (text[article_match.end():], text[:article_match.start()])
    incomplete = None
    for segment in segments:
        for anchor in _PDF_QTY_UNIT_RE.finditer(segment):
            quantity = smart_float(anchor.group("qty"))
            unit = _normalize_pdf_unit(anchor.group("unit"))
            remainder = segment[anchor.end():]
            material_per = _PDF_MATERIAL_PER_RE.match(
                remainder
            ) or _PDF_CURRENCY_MATERIAL_PER_RE.match(remainder)
            if material_per:
                material = _validated_money(material_per.group("material"))
                per = _validated_per(material_per.group("per"))
                if material is not None and per is not None:
                    return {
                        "art": article,
                        "qty": quantity,
                        "unit": unit,
                        "material": material,
                        "per": per,
                        "price": material / per,
                        "price_validated": True,
                    }
            per_only = _PDF_PER_ONLY_RE.match(remainder)
            if per_only:
                incomplete = {
                    "art": article,
                    "qty": quantity,
                    "unit": unit,
                    "material": None,
                    "per": _validated_per(per_only.group("per")),
                    "price": None,
                    "price_validated": False,
                }
            elif unpriced_total := _PDF_UNPRICED_TOTAL_RE.match(remainder):
                incomplete = {
                    "art": article,
                    "qty": quantity,
                    "unit": unit,
                    "material": None,
                    "per": _validated_per(unpriced_total.group("per")),
                    "price": None,
                    "price_validated": False,
                }
            elif _PDF_CURRENCY_ONLY_RE.match(remainder):
                incomplete = {
                    "art": article,
                    "qty": quantity,
                    "unit": unit,
                    "material": None,
                    "per": None,
                    "price": None,
                    "price_validated": False,
                }
    if incomplete:
        return incomplete

    for segment in segments:
        unit_material = _PDF_UNIT_MATERIAL_PER_RE.search(segment)
        if unit_material:
            material = _validated_money(unit_material.group("material"))
            per = _validated_per(unit_material.group("per"))
            if material is not None and per is not None:
                return {
                    "art": article,
                    "qty": None,
                    "unit": _normalize_pdf_unit(unit_material.group("unit")),
                    "material": material,
                    "per": per,
                    "price": material / per,
                    "price_validated": True,
                }

    for segment in segments:
        unit_per = _PDF_UNIT_PER_ONLY_RE.search(segment)
        if unit_per:
            return {
                "art": article,
                "qty": None,
                "unit": _normalize_pdf_unit(unit_per.group("unit")),
                "material": None,
                "per": _validated_per(unit_per.group("per")),
                "price": None,
                "price_validated": False,
            }

    for segment in segments:
        zero_material = _PDF_ZERO_MATERIAL_PER_RE.search(segment)
        if zero_material:
            per = _validated_per(zero_material.group("per"))
            if per is not None:
                return {
                    "art": article,
                    "qty": None,
                    "unit": None,
                    "material": 0.0,
                    "per": per,
                    "price": 0.0,
                    "price_validated": True,
                }
    return None

def _clean_project_name(s: str) -> str:
    if not s:
        return s
    s = re.sub(r"\s+", " ", str(s)).strip()
    s = re.sub(
        r"\b(Angebot|Kunden-?Nr\.?|Projekt-?Nr\.?|Sachbearbeiter|Telefon-?Nr\.?|E-?Mail)\b.*$",
        "",
        s,
        flags=re.IGNORECASE,
    )



def _map_headers(header_row):
    mapping = {}
    for i, c in enumerate(header_row):
        if not isinstance(c, str):
            continue
        h = re.sub(r"\s+", " ", c.strip().lower())
        for canon, alts in HEADER_SYNONYMS.items():
            if any(a in h for a in alts):
                mapping[i] = canon
                break
    return mapping

def _eur_per_unit_from_material_per(material_raw, per_raw) -> Decimal:
    """
    Ermittelt den Angebotspreis pro Stück/Einheit aus den PDF-Spalten 'Material' und 'per'.
    - 'Material' ist der Gesamtpreis, ggf. mit Tausenderpunkten/Komma.
    - 'per' gibt die Staffel (Stückzahl) an; '1' bedeutet Einzelpreis.
    """
    m = _to_decimal_eur(str(material_raw or "0"))
    # 'per' robust in Decimal wandeln (deutsches Komma zulassen); Default = 1
    p_txt = str(per_raw or "1").strip()
    try:
        p = Decimal(p_txt.replace(".", "").replace(",", ".")) if p_txt else Decimal(1)
    except Exception:
        p = Decimal(1)
    if p <= 0:
        p = Decimal(1)
    return (m / p).quantize(Decimal("0.0001"))

def _detect_pdf_meta(text_all: str):
    text_all = text_all or ""

    m_date = DATE_RE.search(text_all)
    datum = pd.to_datetime(m_date.group(0), dayfirst=True, errors="coerce") if m_date else None

    # Match the standalone field, never the suffix in "Jahresangebot BEG".
    # Prose such as "Unser Angebot bezieht sich ..." is not an identifier.
    # Keep the complete suffix: 47172428-001 and 47172428-002 are distinct offers.
    offer_candidates = re.finditer(
        r"\bAngebot\b\s*[:\-]?\s*([0-9A-Za-z][0-9A-Za-z\-\/]*)",
        text_all,
        re.IGNORECASE,
    )
    angebot_nr = next(
        (match.group(1) for match in offer_candidates if re.search(r"[0-9]", match.group(1))),
        None,
    )

    # Projekt ausschließlich aus explizitem 'Projektname:' ziehen
    projekt = None
    m_proj_line = _PROJ_REGEX.search(text_all.replace('\u00a0', ' '))
    if m_proj_line:
        cand = m_proj_line.group(1).strip()
        cand = re.sub(r'\s+', ' ', cand).strip(' :.-|')
        if not re.search(r'\bBEG\s+Badener\s+Elektro\s+GmbH\b', cand, flags=re.IGNORECASE):
            projekt = cand


    supplier = "OBO Bettermann" if "OBO Bettermann" in text_all else None
    return datum, angebot_nr, supplier, (projekt or None)

# [NEU] Gesamtpreis-Erkennung (Netto/Brutto)
_TOTAL_KEY_PATTERNS = [
    # starke Signale zuerst
    (r"(?:^|\b)(?:Angebotswert|Gesamt)\s*(?:zzgl\.?\s*MwSt|netto)\b.*?(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s*EUR", "netto"),
    (r"(?:^|\b)(?:Gesamt(?:betrag|summe)?|Summe)\s*(?:netto)\b.*?(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s*EUR", "netto"),
    # Brutto/inkl.
    (r"(?:^|\b)(?:Gesamt(?:betrag|summe)?|Summe)\s*(?:inkl\.?\s*MwSt|brutto)\b.*?(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s*EUR", "brutto"),
    (r"(?:^|\b)(?:Angebotswert)\s*(?:inkl\.?\s*MwSt|brutto)\b.*?(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s*EUR", "brutto"),
    # generischer Rückfall (mit Vorsicht): „Gesamt zzgl. MwSt … EUR“
    (r"(?:^|\b)Gesamt\s*zzgl\.?\s*MwSt\b.*?(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s*EUR", "netto"),
]

def _extract_offer_totals(text_all: str) -> tuple[float|None, float|None]:
    """
    Liefert (gesamt_netto, gesamt_brutto) als float oder None.
    Priorität: eindeutige Netto-/Brutto-Signale. Als Fallback wird der größte
    Kandidat nahe 'Gesamt/Angebotswert' genommen, Blocksummen werden ignoriert.
    """
    if not text_all:
        return None, None

    txt = text_all.replace("\u00a0", " ")
    netto = None
    brutto = None

    # 1) gezielte Muster mit starker Aussage
    for pat, kind in _TOTAL_KEY_PATTERNS:
        for m in re.finditer(pat, txt, flags=re.IGNORECASE | re.MULTILINE | re.DOTALL):
            val = m.group(1)
            try:
                v = float(val.replace(".", "").replace(",", "."))
            except Exception:
                continue
            if kind == "netto":
                netto = v if (netto is None or v > netto) else netto
            else:
                brutto = v if (brutto is None or v > brutto) else brutto

    # 2) weicher Fallback: Suche nach Zeilen mit 'Gesamt'/'Angebotswert' – aber NICHT 'Blocksumme'
    if netto is None and brutto is None:
        lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
        cand_vals = []
        for ln in lines:
            if "blocksumme" in ln.lower():
                continue
            if re.search(r"\b(gesamt(?:betrag|summe)?|angebotswert)\b", ln, flags=re.IGNORECASE):
                ms = PRICE_RE_DE.findall(ln)
                for raw in ms:
                    try:
                        cand_vals.append(float(raw.replace(".", "").replace(",", ".")))
                    except Exception:
                        pass
        if cand_vals:
            # konservativ: größten Wert nehmen (typisch Gesamt > Zwischen-/Positionssummen)
            # hier fehlt die Netto/Brutto-Eindeutigkeit -> wir interpretieren als Netto
            netto = max(cand_vals)

    return netto, brutto



def _extract_project_from_fixed_region(pdf_path: Path,
                                       page_index: int = PROJECT_PAGE_INDEX,
                                       region_norm: tuple[float, float, float, float] = PROJECT_REGION_NORM) -> str | None:
    """
    Liest den Projektnamen aus einer festen Seiten-Region.
    Wichtig: Liefert nur dann etwas zurück, wenn in der Region wirklich 'Projektname:' gefunden wird.
    Kein Fallback mehr auf 'längste Zeile', um Firmenzeilen (z. B. BEG) zu vermeiden.
    """
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            if page_index < 0 or page_index >= len(pdf.pages):
                return None
            page = pdf.pages[page_index]
            W, H = float(page.width), float(page.height)
            x0, y0, x1, y1 = region_norm
            box = (x0 * W, y0 * H, x1 * W, y1 * H)
            cropped = page.crop(box)
            txt = (cropped.extract_text() or "").strip()
            if not txt:
                return None

            # Nur akzeptieren, wenn explizit 'Projektname:' in der Region steht
            m_proj = _PROJ_REGEX.search(txt.replace('\u00a0', ' '))
            if not m_proj:
                return None

            cand = _clean_project_name(m_proj.group(1))
            if not cand:
                return None

            # Sicherheit: keine offensichtliche Firmenzeile als Projektname akzeptieren
            if re.search(r"\bBEG\s+Badener\s+Elektro\s+GmbH\b", cand, flags=re.IGNORECASE):
                return None

            return cand
    except Exception:
        return None



def parse_row_text_fallback(s: str):
    """
    Parse only an anchored OBO position: quantity, unit, material and ``per``.

    A quantity such as ``95,00 Stück`` is deliberately never accepted as a
    material price when the following material field is empty.
    """
    parsed = _parse_obo_compact_line(s)
    if not parsed:
        return None, None
    return parsed["art"], parsed["price"] if parsed["price_validated"] else None


def _first_non_empty(series: pd.Series):
    values = series.dropna().astype(str).str.strip()
    values = values[values != ""]
    return values.iloc[0] if len(values) else pd.NA


def _aggregate_parsed_positions(frame: pd.DataFrame) -> pd.DataFrame:
    """Aggregate repeated article/unit rows without keeping an arbitrary price."""

    if frame.empty or "PDF_Order" not in frame.columns:
        return frame
    result = frame.sort_values("PDF_Order", kind="stable").copy()
    result["Preis"] = pd.to_numeric(result.get("Preis"), errors="coerce")
    result["Menge"] = pd.to_numeric(result.get("Menge"), errors="coerce")
    result["_unit_group"] = (
        result.get("Einheit (PDF)", pd.Series(index=result.index, dtype=object))
        .fillna("")
        .astype(str)
        .map(lambda value: value.strip().casefold())
    )
    result["_price_valid_group"] = result.get(
        "Preis_validiert",
        pd.Series(False, index=result.index),
    ).fillna(False).astype(bool) & result["Preis"].notna()
    result["Preis_validiert"] = result["_price_valid_group"]

    group_columns = ["Artikelnummer", "Quelle", "_unit_group", "_price_valid_group"]
    grouped = result.groupby(group_columns, sort=False, dropna=False)
    differing_prices = grouped["Preis"].transform("nunique").gt(1)
    missing_quantities = grouped["Menge"].transform(lambda values: values.isna().any())
    negative_quantities = grouped["Menge"].transform(lambda values: values.lt(0).any())
    nonpositive_quantity_sum = grouped["Menge"].transform("sum").le(0)
    cannot_weight = differing_prices & (
        missing_quantities | negative_quantities | nonpositive_quantity_sum
    )
    result["_aggregation_group"] = ""
    result.loc[cannot_weight, "_aggregation_group"] = [
        f"row-{index}" for index in result.index[cannot_weight]
    ]

    def weighted_price(prices: pd.Series):
        numeric = pd.to_numeric(prices, errors="coerce").dropna()
        if numeric.empty:
            return pd.NA
        if numeric.nunique() == 1:
            return float(numeric.iloc[0])
        quantities = pd.to_numeric(result.loc[numeric.index, "Menge"], errors="coerce")
        if quantities.notna().all() and quantities.ge(0).all() and quantities.sum() > 0:
            return float((numeric * quantities).sum() / quantities.sum())
        return pd.NA

    def summed_quantity(quantities: pd.Series):
        return pd.to_numeric(quantities, errors="coerce").sum(min_count=1)

    def unique_per(values: pd.Series):
        numeric = pd.to_numeric(values, errors="coerce").dropna().unique()
        return int(numeric[0]) if len(numeric) == 1 else pd.NA

    aggregations = {
        "PDF_Order": ("PDF_Order", "min"),
        "Preis": ("Preis", weighted_price),
        "Bezeichnung (PDF)": ("Bezeichnung (PDF)", _first_non_empty),
        "Menge": ("Menge", summed_quantity),
        "Einheit (PDF)": ("Einheit (PDF)", _first_non_empty),
        "Preiseinheit (PDF)": ("Preiseinheit (PDF)", unique_per),
        "Preis_validiert": ("Preis_validiert", lambda values: bool(values.fillna(False).all())),
        "Datum": ("Datum", "first"),
        "Angebot": ("Angebot", "first"),
        "Anbieter": ("Anbieter", "first"),
        "Projekt": ("Projekt", "first"),
        "Gesamt (netto)": ("Gesamt (netto)", "first"),
        "Gesamt (brutto)": ("Gesamt (brutto)", "first"),
    }
    aggregations = {
        name: spec
        for name, spec in aggregations.items()
        if spec[0] in result.columns
    }
    result = result.groupby(
        [*group_columns, "_aggregation_group"],
        as_index=False,
        sort=False,
        dropna=False,
    ).agg(**aggregations)
    return result.drop(
        columns=["_unit_group", "_price_valid_group", "_aggregation_group"]
    ).sort_values(
        "PDF_Order",
        kind="stable",
    )



def extract_prices_from_pdf(pdf_source, cache_sig: str | None = None, source_name: str | None = None):
    import io
    import pdfplumber
    import re
    from pathlib import Path

    if isinstance(pdf_source, (bytes, bytearray)):
        pdf_input = io.BytesIO(bytes(pdf_source))
        pdf_name = str(source_name or "remote.pdf")
    else:
        pdf_path = Path(str(pdf_source))
        pdf_input = str(pdf_path)
        pdf_name = str(source_name or pdf_path.name)

    results = []
    seq = 0

    datum = None
    angebot_nr = None
    supplier = None
    projekt = None
    text_all_parts = []

    meta_cols = [
        "Artikelnummer","Preis","Quelle","PDF_Order",
        "Bezeichnung (PDF)",
        "Menge",
        "Einheit (PDF)",
        "Preiseinheit (PDF)",
        "Preis_validiert",
        "Datum","Angebot","Anbieter","Projekt",
        "Gesamt (netto)","Gesamt (brutto)"
    ]

    def to_float(s):
        if s is None: return None
        s = str(s).strip()
        s = re.sub(r'[^0-9.,-]', '', s)
        if not s: return None
        s = s.replace('.', '').replace(',', '.')
        try: return float(s)
        except Exception: return None

    # NEU: Menge robust lesen; wenn Komma vorhanden -> IMMER abrunden
        # NEU: Menge robust lesen (DE-Komma), Dezimalwerte beibehalten
    def parse_qty_cell(cell):
        if cell is None:
            return None
        raw = str(cell).strip()
        if not raw or not re.fullmatch(_PDF_NUMBER_DE, raw):
            return None

        q = smart_float(raw)
        if q is None:
            return None

        # Dezimalmengen beibehalten (z.B. 0,51 Stück)
        return float(q)


    def parse_obo_compact_line(line: str):
        return _parse_obo_compact_line(line)


    def find_artikelnummer_in_row(row):
        best = None
        for cell in row:
            t = str(cell or '').strip()
            m = re.search(r'\b(\d{6,8})\b', t)
            if m:
                best = m.group(1)
                break
        return best

    def parse_table_position(row, col_map):
        cells = list(row or [])
        joined = " ".join(str(cell or "").replace("\n", " ") for cell in cells)
        compact = parse_obo_compact_line(joined)
        art = find_artikelnummer_in_row(cells) or (compact or {}).get("art")
        if not art:
            return None

        indices = {canon: index for index, canon in col_map.items()}
        qty_idx = indices.get("Menge")
        unit_idx = indices.get("Einheit")
        desc_idx = indices.get("Bezeichnung")
        mat_idx = indices.get("Material")
        per_idx = indices.get("per")
        price_idx = indices.get("Preis")

        qty = parse_qty_cell(cells[qty_idx]) if qty_idx is not None and qty_idx < len(cells) else None
        unit = (
            _normalize_pdf_unit(cells[unit_idx])
            if unit_idx is not None and unit_idx < len(cells)
            else None
        )
        if qty is None and unit_idx is not None and 0 < unit_idx < len(cells):
            qty = parse_qty_cell(cells[unit_idx - 1])
        if compact:
            if compact.get("qty") is not None:
                qty = compact.get("qty")
            if compact.get("unit") is not None:
                unit = compact.get("unit")

        price = None
        per = None
        invalid_explicit_price_per = False
        if price_idx is not None and price_idx < len(cells):
            price = _validated_money(cells[price_idx])
            if price is not None:
                raw_per = (
                    cells[per_idx]
                    if per_idx is not None and per_idx < len(cells)
                    else None
                )
                has_explicit_per = raw_per is not None and bool(str(raw_per).strip())
                explicit_per = _validated_per(raw_per) if has_explicit_per else None
                if has_explicit_per and explicit_per is None:
                    invalid_explicit_price_per = True
                    price = None
                else:
                    per = explicit_per or 1
                    price /= per

        if price is None and mat_idx is not None and mat_idx < len(cells):
            material_cell = cells[mat_idx]
            material = _validated_money(material_cell)
            explicit_per = (
                _validated_per(cells[per_idx])
                if per_idx is not None and per_idx < len(cells)
                else None
            )
            if explicit_per is not None:
                per = explicit_per
            if material is not None and explicit_per is not None:
                price = material / explicit_per
            elif material is None:
                combined = re.fullmatch(
                    rf"\s*(?P<material>{_PDF_MONEY_DE})\s+(?P<per>\d{{1,5}})\s*",
                    str(material_cell or ""),
                )
                if combined:
                    material = _validated_money(combined.group("material"))
                    explicit_per = _validated_per(combined.group("per"))
                    if material is not None and explicit_per is not None:
                        price = material / explicit_per
                        per = explicit_per

        if (
            price is None
            and not invalid_explicit_price_per
            and compact
            and compact.get("price_validated")
        ):
            price = compact.get("price")
            per = compact.get("per")

        if price is None:
            if compact:
                per = compact.get("per")
            if qty is None or unit is None:
                return None

        description = None
        if desc_idx is not None and desc_idx < len(cells):
            description = str(cells[desc_idx] or "").strip() or None

        return {
            "Artikelnummer": clean_artnr(art),
            "Preis": float(price) if price is not None else None,
            "Bezeichnung (PDF)": description,
            "Menge": qty,
            "Einheit (PDF)": unit,
            "Preiseinheit (PDF)": per,
            "Preis_validiert": price is not None,
        }

    def position_fingerprint(position):
        quantity = position.get("Menge")
        price = position.get("Preis")
        per = position.get("Preiseinheit (PDF)")
        return (
            str(position.get("Artikelnummer") or ""),
            None if price is None else round(float(price), 8),
            None if quantity is None else round(float(quantity), 8),
            str(position.get("Einheit (PDF)") or "").casefold(),
            None if per is None else int(per),
        )

    def position_identity(position):
        quantity = position.get("Menge")
        return (
            str(position.get("Artikelnummer") or ""),
            None if quantity is None else round(float(quantity), 8),
            str(position.get("Einheit (PDF)") or "").casefold(),
        )

    try:
        with pdfplumber.open(pdf_input) as pdf:
            fixed_proj = None
            for page_index_loop, page in enumerate(pdf.pages):
                # Projektname aus fixer Region (nur Seite 0)
                if fixed_proj is None and page_index_loop == PROJECT_PAGE_INDEX:
                    try:
                        W, H = float(page.width), float(page.height)
                        x0, y0, x1, y1 = PROJECT_REGION_NORM
                        box = (x0*W, y0*H, x1*W, y1*H)
                        cropped = page.crop(box)
                        txt_region = (cropped.extract_text() or "").strip()
                        if txt_region:
                            m_proj = _PROJ_REGEX.search(txt_region.replace("\u00a0", " "))
                            if m_proj:
                                cand = _clean_project_name(m_proj.group(1))
                                if cand and not re.search(r"\bBEG\s+Badener\s+Elektro\s+GmbH\b", cand, flags=re.IGNORECASE):
                                    fixed_proj = cand
                    except Exception:
                        pass

                # Tabellen
                try:
                    tables = page.extract_tables() or []
                except Exception:
                    tables = []

                # Meta-Text sammeln
                try:
                    txt_meta = page.extract_text() or ""
                except Exception:
                    txt_meta = ""
                text_all_parts.append(txt_meta)

                table_fingerprints = Counter()
                validated_table_identities = Counter()
                for tbl in tables:
                    header_row = None
                    header_idx = 0
                    for idx, row in enumerate(tbl or []):
                        if row and any(str(cell or "").strip() for cell in row):
                            header_row = row
                            header_idx = idx
                            break
                    col_map = _map_headers(header_row) if header_row else {}
                    rows = (tbl or [])[header_idx + 1:] if col_map else (tbl or [])
                    for row in rows:
                        position = parse_table_position(row, col_map)
                        if position is None:
                            continue
                        seq += 1
                        position["Quelle"] = pdf_name
                        position["PDF_Order"] = int(seq)
                        results.append(position)
                        table_fingerprints[position_fingerprint(position)] += 1
                        if position.get("Preis_validiert"):
                            validated_table_identities[position_identity(position)] += 1

                # Text-Fallback pro Zeile
                try:
                    txt = page.extract_text() or ""
                except Exception:
                    txt = ""
                text_positions = []
                for ln in (txt.splitlines() if txt else []):
                    ln = (ln or "").strip()
                    if not ln:
                        continue
                    compact = parse_obo_compact_line(ln)
                    if not compact:
                        continue
                    position = {
                        "Artikelnummer": compact["art"],
                        "Preis": (
                            float(compact["price"])
                            if compact.get("price_validated")
                            else None
                        ),
                        "Quelle": pdf_name,
                        "Bezeichnung (PDF)": None,
                        "Menge": compact.get("qty"),
                        "Einheit (PDF)": compact.get("unit"),
                        "Preiseinheit (PDF)": compact.get("per"),
                        "Preis_validiert": bool(compact.get("price_validated")),
                    }
                    text_positions.append(position)

                skipped_text_positions = set()
                for index, position in enumerate(text_positions):
                    fingerprint = position_fingerprint(position)
                    if table_fingerprints[fingerprint] > 0:
                        table_fingerprints[fingerprint] -= 1
                        if (
                            position.get("Preis_validiert")
                            and validated_table_identities[position_identity(position)] > 0
                        ):
                            validated_table_identities[position_identity(position)] -= 1
                        skipped_text_positions.add(index)

                for index, position in enumerate(text_positions):
                    if index in skipped_text_positions:
                        continue
                    identity = position_identity(position)
                    if (
                        not position.get("Preis_validiert")
                        and validated_table_identities[identity] > 0
                    ):
                        validated_table_identities[identity] -= 1
                        continue
                    seq += 1
                    position["PDF_Order"] = int(seq)
                    results.append(position)


            # Projekt bestimmen (fixe Region > strikter Scan > Fallback)
            text_all = "\n".join([p for p in text_all_parts if isinstance(p, str)]) or ""
            d, a, s, p = _detect_pdf_meta(text_all)
            datum, angebot_nr, supplier = d, a, s

        

            # [FIX] strict_proj war undefiniert → NameError → Exception-Pfad
            strict_proj = None
            projekt = fixed_proj or strict_proj or p or "-"


            # Gesamtsummen Netto/Brutto aus komplettem Text
            total_net, total_gross = _extract_offer_totals(text_all)


            # WICHTIG: Ohne starre columns-Liste bauen, damit neue Spalten (z. B. Bezeichnung (PDF)) erhalten bleiben
            df = pd.DataFrame(results if results else [])

            try:
                df["Datum"] = pd.to_datetime(datum) if datum is not None else pd.NaT
            except Exception:
                df["Datum"] = pd.NaT
            df["Angebot"] = angebot_nr or None
            df["Anbieter"] = supplier or None
            df["Projekt"]  = projekt or None
            df["Gesamt (netto)"]  = (total_net   if (total_net   is not None) else pd.NA)
            df["Gesamt (brutto)"] = (total_gross if (total_gross is not None) else pd.NA)

            if not df.empty:
                df = _aggregate_parsed_positions(df)


            # fehlende Spalten nachziehen, Reihenfolge vereinheitlichen
            for c in meta_cols:
                if c not in df.columns:
                    df[c] = pd.NA
            df = df[meta_cols]
            return df


    except Exception:
        # Fehlerweg: gleiche Rückgabeform wie oben
        text_all = "\n".join([p for p in text_all_parts if isinstance(p, str)]) or ""
        d, a, s, p = _detect_pdf_meta(text_all)
        total_net, total_gross = _extract_offer_totals(text_all)

        # Ohne starre columns-Liste bauen
        df = pd.DataFrame(results if results else [])

        try:
            df["Datum"] = pd.to_datetime(d) if d is not None else pd.NaT
        except Exception:
            df["Datum"] = pd.NaT
        df["Angebot"] = a or None
        df["Anbieter"] = s or None
        df["Projekt"]  = p or None
        df["Gesamt (netto)"]  = (total_net   if (total_net   is not None) else pd.NA)
        df["Gesamt (brutto)"] = (total_gross if (total_gross is not None) else pd.NA)

        if not df.empty and "PDF_Order" in df.columns:
            df = _aggregate_parsed_positions(df)


        # fehlende Spalten nachziehen, Reihenfolge vereinheitlichen
        for c in meta_cols:
            if c not in df.columns:
                df[c] = pd.NA
        df = df[meta_cols]
        return df


__all__ = [
    "extract_prices_from_pdf",
    "parse_row_text_fallback",
    "_detect_pdf_meta",
    "_extract_offer_totals",
    "_map_headers",
    "_clean_project_name",
    "_extract_project_from_fixed_region",
]
