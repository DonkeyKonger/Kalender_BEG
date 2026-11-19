from __future__ import annotations


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
    "Preis": [
        "preis", "betrag", "kosten", "netto", "brutto", "ep"
    ],
    "Gesamt": [
        "gesamt", "summe", "gesamtpreis", "blocksumme"
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

    m_offer = re.search(r"Angebot\s*[:\-]?\s*([0-9A-Za-z\-\/]+)", text_all, re.IGNORECASE)
    angebot_nr = m_offer.group(1).strip() if m_offer else None

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
    Fallback-Zeilenparser:
    - findet Preis(e) in der Zeile
    - sucht direkt RECHTS davon nach einer ganzen Zahl ('per') und teilt ggf. Preis/per
    - wählt dabei das Paar mit dem größten 'per' (>1), damit 'Material 18,12 100  Gesamt 18,12 1'
      korrekt zu 0,1812 wird (18,12/100) statt 18,12/1
    """
    if not s:
        return None, None

    line = s.replace("\n", " ")
    if SUM_ROW_PAT.search(line):
        return None, None

    # Artikelnummer
    m_art = ARTNR_RE.search(line)
    art = clean_artnr(m_art.group(0)) if m_art else None

    # 1) Preis/per-Paare direkt aus der Zeile herausfischen
    #    Muster: "<Preis mit 2 Dezimalstellen> <ganze Zahl>"
    pair_re = re.compile(r"(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s+(\d{1,5})\b")
    pairs = []
    for m in pair_re.finditer(line):
        p_raw, per_raw = m.group(1), m.group(2)
        p = smart_float(p_raw)
        try:
            per_val = int(per_raw)
        except ValueError:
            per_val = None
        if p is not None and per_val is not None and per_val > 1 and per_val <= 10000:
            pairs.append((p, per_val, m.start(), m.end()))

    if pairs:
        # Nimm das Paar mit dem größten 'per' (typisch: 100 schlägt 1 von 'Gesamt per')
        p, per_val, _, _ = max(pairs, key=lambda t: t[1])
        return art, (p / per_val)

    # 2) Kein Paar gefunden? Dann wie bisher den (letzten) Preis nehmen
    price = None
    last_match = None
    for m in PRICE_RE_DE.finditer(line):
        last_match = m
    if last_match:
        price = float(last_match.group(0).replace(".", "").replace(",", "."))
    if price is None:
        ms = re.findall(r"\d{1,3}(?:[.,]\d{2})", line)
        if ms:
            price = smart_float(ms[-1])

    return art, price



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
        if not raw:
            return None

        q = to_float(raw)
        if q is None:
            return None

        # Dezimalmengen beibehalten (z.B. 0,51 Stück)
        return float(q)


    def parse_obo_compact_line(line: str):
        """
        OBO-Compact-Fallback:
        - komplette Zeile steckt oft in row[0]
        - wir ziehen: ArtNr, Menge (erste passende Zahl rechts nach ArtNr), Einheit (nur als Anker),
          sowie Material/per (für Einzelpreis)
        Regel Menge:
          - bevorzugt Muster "<Menge> <Einheit>"
          - sonst: erste Zahl (mit Komma oder Punkt) rechts nach ArtNr, die NICHT wie ein Preisblock wirkt
        """
        if not line:
            return None

        s = str(line).replace("\n", " ").lstrip().strip()
        if not s:
            return None

        # ------------------------------------------------------------
        # NEU: OBO-PDF hat in row[0] oft Summenzeilen (fett):
        # "Preis pro Einheit", "Blocksumm(e)" etc.
        # Diese enthalten Mengen wie "120,00 Stück" und dürfen NICHT als Artikelmenge zählen.
        # => alles ab diesen Markern abschneiden.
        # ------------------------------------------------------------
        cut_markers = [
            "preis pro einheit",
            "blocksumme",
            "blockssumme",   # falls OCR/Extraktion Mist baut
            "blocksumm",     # deckt auch "Blocksummme" ab
            "pos.lv."
        ]
        s_lower = s.lower()
        cut_pos = None
        for mk in cut_markers:
            p = s_lower.find(mk)
            if p != -1:
                cut_pos = p if cut_pos is None else min(cut_pos, p)

        if cut_pos is not None:
            s = s[:cut_pos].strip()
            if not s:
                return None

        # Artikelnummer
        m_art = re.search(r"\b(\d{6,9})\b", s)
        if not m_art:
            return None
        art = m_art.group(1)

        # ------------------------------------------------------------
        # NEU: OBO-Zeilen haben oft die Artikelnummer AM ZEILENENDE.
        # Dann stehen Menge/ME/Preis/per direkt davor, z.B.:
        # "LCIS 610 3 FT 100,00  Meter 20,03 1  6209719"
        # -> wir parsen die letzten Tokens robust.
        # ------------------------------------------------------------
        m_end = re.search(
            r"(\d{1,3}(?:[.\s]?\d{3})*(?:,\d+)?)\s+"
            r"(Stück|Stk\.?|Meter|m|lfm|Lfm|mtr|Mtr)\s+"
            r"(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s+"
            r"(\d{1,5})\s+"
            + re.escape(art) + r"\s*$",
            s,
            flags=re.IGNORECASE
        )
        if m_end:
            qty = parse_qty_cell(m_end.group(1))
            unit_raw = m_end.group(2) or ""
            u = unit_raw.lower().rstrip(".")
            if u.startswith("stk") or u in ("stück", "stueck"):
                unit = "Stück"
            elif u in ("m", "meter", "lfm", "mtr"):
                unit = "Meter"
            else:
                unit = unit_raw

            material = to_float(m_end.group(3))
            try:
                per = int(to_float(m_end.group(4)) or 0)
            except Exception:
                per = None

            return {"art": art, "qty": qty, "unit": unit, "material": material, "per": per}

        # tail = alles rechts von der ArtNr (Anker-Fall wenn ArtNr NICHT am Ende steht)
        tail = s[m_art.end():]

        # Einheit (ME) – nur als Anker/Hilfe, nicht „zwingend“
        unit_pat = r"(Stück|Stk\.?|Meter|m|lfm|Lfm|mtr|Mtr)"
        unit = None
        qty = None

        # 1) stärkster Treffer: "<Menge> <Einheit>" irgendwo rechts nach ArtNr
        m_qu = re.search(
            # FIX: KEIN \s als Tausendertrenner, sonst wird "A2 450,00" zu "2 450,00" => 2450,00
            r"(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s+" + unit_pat + r"\b",
            tail,
            flags=re.IGNORECASE
        )
        if m_qu:
            qty = parse_qty_cell(m_qu.group(1))
            unit_raw = m_qu.group(2) or ""
            u = unit_raw.lower().rstrip(".")
            if u.startswith("stk") or u in ("stück", "stueck"):
                unit = "Stück"
            elif u in ("m", "meter", "lfm", "mtr"):
                unit = "Meter"
            else:
                unit = unit_raw

        # 2) Material/per-Paare: "<Preis> <per>"
        pair_re = re.compile(r"(\d{1,3}(?:[.\s]?\d{3})*(?:[.,]\d{2}))\s+(\d{1,5})\b")
        pairs = []
        for m in pair_re.finditer(tail):
            p_raw, per_raw = m.group(1), m.group(2)
            p = to_float(p_raw)
            try:
                per_val = int(per_raw)
            except Exception:
                continue
            if p is not None and 1 <= per_val <= 10000:
                pairs.append((float(p), int(per_val)))

        material = None
        per = None
        if pairs:
            # bevorzugt große per (>1), sonst letztes Paar
            gt1 = [x for x in pairs if x[1] > 1]
            material, per = max(gt1, key=lambda t: t[1]) if gt1 else pairs[-1]

        return {"art": art, "qty": qty, "unit": unit, "material": material, "per": per}



    def find_artikelnummer_in_row(row):
        best = None
        for cell in row:
            t = str(cell or '').strip()
            m = re.search(r'\b(\d{6,8})\b', t)
            if m:
                best = m.group(1)
                break
        return best

    def find_preis_in_row(row):
        preis = None; preis_col_idx = None
        for i in range(len(row)-1, -1, -1):
            val = str(row[i] or '')
            if re.search(r'\d[\d\.,]*[\.,]\d{2}', val):
                p = to_float(val)
                if p is not None:
                    preis = p; preis_col_idx = i; break
        return preis, preis_col_idx

    def find_per_qty_in_row(row, preis_col_idx):
        candidates = []
        for j in range((preis_col_idx or -1)+1, len(row)):
            q   = to_float(row[j])
            txt = str(row[j] or '')
            has_dec = bool(re.search(r'[\.,]\d{2}\b', txt))
            if q is not None and not has_dec and q > 1 and q <= 10000:
                candidates.append(int(q))
        if candidates: return candidates[-1]
        all_ints = []
        for j, v in enumerate(row):
            q   = to_float(v)
            txt = str(v or '')
            has_dec = bool(re.search(r'[\.,]\d{2}\b', txt))
            if q is not None and not has_dec and q > 1 and q <= 10000:
                all_ints.append(int(q))
        return all_ints[-1] if all_ints else None

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

                for tbl in tables:
                    # Header finden
                    header_row = None; header_idx = 0
                    for idx, r in enumerate(tbl or []):
                        if r and any(str(c or '').strip() for c in r):
                            header_row = r; header_idx = idx; break
                    # [ANCHOR: pdf-table-parse - AFTER]
                    # [ANCHOR: pdf-table-parse - AFTER]
                    mat_idx = per_idx = None
                    desc_idx = None  # <— Index für "Bezeichnung"
                    qty_idx  = None  # <— NEU: Index für "Menge"
                    unit_idx = None  # <— NEU: Index für "Einheit"
                    if header_row:
                        col_map = _map_headers(header_row)
                        for i, canon in col_map.items():
                            c = str(canon).strip().lower()
                            if c == "material" and mat_idx is None:
                                mat_idx = i
                            elif c == "per" and per_idx is None:
                                per_idx = i
                            elif c == "bezeichnung" and desc_idx is None:
                                desc_idx = i
                            elif c == "menge" and qty_idx is None:
                                qty_idx = i
                            elif c == "einheit" and unit_idx is None:
                                unit_idx = i



                    if mat_idx is not None and per_idx is not None:
                        # Material / per -> Einzelpreis
                        for row in (tbl or [])[header_idx+1:]:
                            if not row: continue
                            art = find_artikelnummer_in_row(row)
                            if not art: continue
                            material = to_float(row[mat_idx]) if mat_idx < len(row) else None
                            per_qty  = to_float(row[per_idx])  if per_idx  < len(row) else None

                            # NEU: falls Spalten leer sind (oft bei OBO), aus row[0] parsen
                            compact = None
                            if material is None or per_qty is None:
                                compact = parse_obo_compact_line(row[0] if len(row) > 0 else "")
                                if compact:
                                    if material is None and compact.get("material") is not None:
                                        material = float(compact["material"])
                                    if (per_qty is None or not per_qty) and compact.get("per") is not None:
                                        per_qty = float(compact.get("per") or 1)

                        

                            if material is None:
                                continue
                            if not per_qty or per_qty <= 0:
                                per_qty = 1.0

                            preis = float(material) / float(per_qty)

                            seq += 1
                            qty_val = None
                            unit_val = None

                            # Einheit lesen (wenn erkannt)
                            if unit_idx is not None and unit_idx < len(row):
                                unit_val = str(row[unit_idx] or "").strip() or None

                            # Menge: bei OBO steht sie in der Praxis fast immer direkt links von der Einheit (ME)
                            qty_val = None

                            # 1) bevorzugt: links von der Einheit
                            if unit_idx is not None and unit_idx > 0 and unit_idx < len(row):
                                qty_val = parse_qty_cell(row[unit_idx - 1])

                            # 2) fallback: qty_idx aus Header-Mapping (nur wenn links von Einheit nichts parsebar war)
                            if qty_val is None and qty_idx is not None and qty_idx < len(row):
                                qty_val = parse_qty_cell(row[qty_idx])

                            # Bezeichnung (wenn erkannt)
                            bez_pdf = None
                            if desc_idx is not None and desc_idx < len(row):
                                bez_pdf = str(row[desc_idx] or "").strip() or None

                            # ✅ NEU: Wenn Menge/Einheit (oder Bezeichnung) fehlen → compact-line Parser nutzen
                            if (qty_val is None) or (unit_val is None) or (bez_pdf is None):
                                compact2 = parse_obo_compact_line(row[0] if len(row) > 0 else "")
                                if compact2:
                                    if qty_val is None:
                                        qty_val = compact2.get("qty")
                                    if unit_val is None:
                                        unit_val = compact2.get("unit")
                                    if bez_pdf is None:
                                        # optional: nicht zwingend, aber schadet nicht
                                        bez_pdf = None  # compact parser liefert aktuell keine Bezeichnung

                            results.append({
                                "Artikelnummer": art,
                                "Preis": preis,
                                "Quelle": pdf_name,
                                "PDF_Order": int(seq),
                                "Bezeichnung (PDF)": bez_pdf,
                                "Menge": qty_val,            # <— NEU
                                "Einheit (PDF)": unit_val,   # <— optional, schadet nicht
                            })

                    else:
                        # Fallback: Preis + „per“ rechts davon
                        for row in (tbl or []):
                            compact = None  # <-- NEU: pro Zeile initialisieren
                            if not row: 
                                continue
                            art, (preis, preis_col_idx) = find_artikelnummer_in_row(row), find_preis_in_row(row)

                            if art and (preis is not None):
                                # NEU: Bezeichnung (wenn Header existiert und Index bekannt)
                                bez_pdf = None
                                if desc_idx is not None and desc_idx < len(row):
                                    bez_pdf = str(row[desc_idx] or "").strip() or None

                                qty_val = None
                                unit_val = None

                                # Menge: bei OBO bevorzugt links von der Einheit (ME)
                                qty_val = None

                                if unit_idx is not None and unit_idx > 0 and unit_idx < len(row):
                                    qty_val = parse_qty_cell(row[unit_idx - 1])

                                if qty_val is None and qty_idx is not None and qty_idx < len(row):
                                    qty_val = parse_qty_cell(row[qty_idx])

                                # NEU: wenn Menge/Einheit in Spalten nicht kommt, aus compact ziehen
                                if (qty_val is None or unit_val is None):
                                    if compact is None:
                                        compact = parse_obo_compact_line(row[0] if len(row) > 0 else "")
                                    if compact:
                                        if qty_val is None:
                                            qty_val = compact.get("qty")
                                        if unit_val is None:
                                            unit_val = compact.get("unit")


                                # Menge primär über qty_idx
                                if qty_idx is not None and qty_idx < len(row):
                                    qty_val = parse_qty_cell(row[qty_idx])

                                # Fallback: wenn keine Menge erkannt, aber Einheit existiert -> Menge steht meist links davon
                                if qty_val is None and unit_idx is not None and unit_idx > 0 and unit_idx < len(row):
                                    qty_val = parse_qty_cell(row[unit_idx - 1])


                                results.append({
                                    "Artikelnummer": art,
                                    "Preis": preis,
                                    "Quelle": pdf_name,
                                    "PDF_Order": int(seq),
                                    "Bezeichnung (PDF)": bez_pdf,
                                    "Menge": qty_val,            # <— NEU
                                    "Einheit (PDF)": unit_val,   # <— optional, schadet nicht
                                })


                # Text-Fallback pro Zeile
                try:
                    txt = page.extract_text() or ""
                except Exception:
                    txt = ""
                for ln in (txt.splitlines() if txt else []):
                    ln = (ln or "").strip()
                    if not ln:
                        continue

                    art, pr = parse_row_text_fallback(ln)
                    if art and (pr is not None):
                        seq += 1

                        qty_val = None
                        unit_val = None

                        # ✅ Menge/Einheit aus der Zeile ziehen (OBO-Compact Parser)
                        compact = parse_obo_compact_line(ln)
                        if compact:
                            qty_val = compact.get("qty")
                            unit_val = compact.get("unit")

                        results.append({
                            "Artikelnummer": art,
                            "Preis": pr,
                            "Quelle": pdf_name,
                            "PDF_Order": int(seq),
                            "Menge": qty_val,
                            "Einheit (PDF)": unit_val,
                        })


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
                if "PDF_Order" in df.columns:
                    df = df.sort_values(["PDF_Order"]).copy()

                # Menge numerisch machen (damit sum sauber klappt)
                if "Menge" in df.columns:
                    df["Menge"] = pd.to_numeric(df["Menge"], errors="coerce")

                def _first_non_empty(s: pd.Series):
                    s2 = s.dropna().astype(str).str.strip()
                    s2 = s2[s2 != ""]
                    return (s2.iloc[0] if len(s2) else pd.NA)

                agg = {
                    "PDF_Order": ("PDF_Order", "min"),
                    "Preis": ("Preis", "first"),
                    "Bezeichnung (PDF)": ("Bezeichnung (PDF)", _first_non_empty),
                    "Menge": ("Menge", "sum"),
                    "Einheit (PDF)": ("Einheit (PDF)", _first_non_empty),
                    "Datum": ("Datum", "first"),
                    "Angebot": ("Angebot", "first"),
                    "Anbieter": ("Anbieter", "first"),
                    "Projekt": ("Projekt", "first"),
                    "Gesamt (netto)": ("Gesamt (netto)", "first"),
                    "Gesamt (brutto)": ("Gesamt (brutto)", "first"),
                }

                # nur Spalten aggregieren, die existieren
                agg = {k: v for k, v in agg.items() if k in df.columns}

                df = df.groupby(["Artikelnummer", "Quelle"], as_index=False).agg(**agg)

                if "PDF_Order" in df.columns:
                    df = df.sort_values(["PDF_Order"])


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
            # Statt Duplikate zu droppen: je Artikel im Angebot Mengen aufsummieren
            df = df.sort_values(["PDF_Order"]).copy()

            # Menge numerisch ziehen (falls irgendwo Text/NA drin ist)
            if "Menge" in df.columns:
                df["Menge"] = pd.to_numeric(df["Menge"], errors="coerce")

            def _first_non_empty(s: pd.Series):
                s2 = s.dropna().astype(str).str.strip()
                s2 = s2[s2 != ""]
                return (s2.iloc[0] if len(s2) else pd.NA)

            agg = {
                "PDF_Order": ("PDF_Order", "min"),
                "Preis": ("Preis", "first"),
                "Bezeichnung (PDF)": ("Bezeichnung (PDF)", _first_non_empty),
                "Menge": ("Menge", "sum"),
                "Einheit (PDF)": ("Einheit (PDF)", _first_non_empty),
            }

            # Nur Spalten aggregieren, die auch wirklich existieren
            agg = {k: v for k, v in agg.items() if k in df.columns}

            df = df.groupby(["Artikelnummer", "Quelle"], as_index=False).agg(**agg)
            df = df.sort_values(["PDF_Order"])


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
