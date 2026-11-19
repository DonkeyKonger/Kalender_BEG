# ruff: noqa: E501,F821,F841
"""Frozen export-function reference from the original BEG Preisviewer.

Source: viewer.py at 4ed988fdb49a4db355d7c2361dbcf8e272ae563d.
AST allowlist only; no authentication, credentials, persistence, or UI code.
"""

def _extract_projectname_from_text(txt: str) -> str | None:
    """
    Zieht den Projektnamen aus einem gegebenen Textblock.
    Nimmt nur die Sequenz nach 'Projektname:' und schneidet 'Angebot ...' weg.
    """
    if not txt:
        return None
    m = _PROJ_REGEX.search(txt.replace("\u00a0", " ").replace("\uf0b7", " "))
    if not m:
        return None
    name = m.group(1).strip()
    # Aufräumen: Mehrfach-Whitespace normalisieren
    name = re.sub(r"\s{2,}", " ", name)
    # Sicherheit: Offensichtliche Kunden-/Firmenzeilen niemals als Projektname akzeptieren
    if name.lower().startswith("beg badener elektro gmbh"):
        return None
    return name or None

def _extract_projectname_from_pdf(pdf_source) -> str | None:
    """
    Öffnet nur die erste Seite (Performance!) und versucht dort den Projektnamen zu finden.
    Fällt ansonsten auf None zurück (niemals auf Kunden-/Firmennamen).
    """
    try:
        with _open_pdfplumber_from_storage(pdf_source) as pdf:
            if not pdf.pages:
                return None
            first_page = pdf.pages[0]
            txt = first_page.extract_text() or ""
            return _extract_projectname_from_text(txt)
    except Exception:
        return None

def clean_artnr(artnr: str) -> str:
    s = re.sub(r"[^0-9A-Za-z]", "", str(artnr)).upper()
    return s.lstrip("0")

def _pn_pad_fixed(val: str, length: int, align: str = "left", pad: str = " ") -> str:
    s = "" if val is None else str(val)
    if len(s) > length:
        s = s[:length]
    if align == "right":
        return s.rjust(length, pad)
    return s.ljust(length, pad)

def _pn_write_field(buf: list[str], start_1: int, length: int, val: str, align: str = "left", pad: str = " ") -> None:
    """Schreibt ein Feld in eine 350-Zeichen-Zeile (start_1 ist 1-based)."""
    s = _pn_pad_fixed(val, length, align=align, pad=pad)
    start0 = start_1 - 1
    for i, ch in enumerate(s):
        if 0 <= start0 + i < len(buf):
            buf[start0 + i] = ch

def _pn_make_line_350() -> list[str]:
    return [" "] * 350

def _pn_line_to_str(line: list[str]) -> str:
    if len(line) != 350:
        line = (line + [" "] * 350)[:350]
    return "".join(line)

def _pn_extract_kundennr_from_pdf(pdf_source) -> str | None:
    """Kunden-Nr. (10-stellig) aus PDF-Kopf lesen, z.B. 615099 -> 0000615099."""
    try:
        with _open_pdfplumber_from_storage(pdf_source) as pdf:
            if not pdf.pages:
                return None
            txt = pdf.pages[0].extract_text() or ""
        txt = txt.replace("\u00a0", " ").replace("\uf0b7", " ")
        m = _PN_KUNDENNR_RE.search(txt)
        if not m:
            return None
        raw = re.sub(r"[^0-9]", "", m.group(1) or "")
        if not raw:
            return None
        return raw[:10]
    except Exception:
        return None

def _pn_extract_projektnr_from_pdf(pdf_source) -> str | None:
    """Projekt-/Vorgangsnummer aus PDF-Kopf lesen (KOP 26–40, max 15 Zeichen)."""
    try:
        with _open_pdfplumber_from_storage(pdf_source) as pdf:
            if not pdf.pages:
                return None
            txt = pdf.pages[0].extract_text() or ""
        txt = txt.replace("\u00a0", " ").replace("\uf0b7", " ")
        m = _PN_PROJEKTNR_RE.search(txt)
        if not m:
            return None
        raw = (m.group(1) or "").strip()
        raw = re.sub(r"\s{2,}", " ", raw)
        return raw[:15] if raw else None
    except Exception:
        return None

def _pn_int_scaled(val: object, decimals: int) -> int:
    """Skaliert Zahl zu Integer: decimals=2 (EUR->Cent), decimals=3 (Menge->Tausendstel)."""
    try:
        if pd.isna(val):
            return 0
    except Exception:
        pass
    try:
        d = Decimal(str(val).replace(",", "."))
    except Exception:
        return 0
    scale = Decimal(10) ** decimals
    return int((d * scale).quantize(Decimal("1"), rounding="ROUND_HALF_UP"))

def _pn_clean_artnr_for_pn(val: object) -> str:
    a = clean_artnr(str(val or ""))
    return a.lstrip("0")

def _pn_unit_code(val: object) -> str:
    """
    Normalisiert Einheiten auf PN/UGL (3 Zeichen).
    Default: 'ST '.
    """
    s = "" if val is None else str(val).strip()
    if not s:
        return "st "

    low = s.lower().replace(".", "")

    # Meter / Laufmeter
    if low in {"m", "meter", "lfm", "laufmeter", "mtr"}:
        return "m  "  # 3 Zeichen

    # Stück
    if low in {"st", "stk", "stück", "stueck", "piece", "pcs"}:
        return "st "

    # Wenn schon PN-tauglich (z.B. "ST " / "M  ")
    if len(s) == 3:
        return s

    return "st "

def _pn_extract_kuerzel_from_text(text: object) -> str:
    """
    Extrahiert Artikelkürzel aus OBO-typischen Bezeichnungstexten:
    - ignoriert Zeilen wie "Gewicht: ..."
    - wählt die Zeile, die am ehesten wie ein Typ/Kürzel aussieht (z.B. "LB 90 640 R3 FS")
    - schneidet ab "für ..." weg
    """
    s = "" if text is None else str(text)

    # Zeilen normalisieren
    raw_lines = s.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in raw_lines]
    lines = [ln for ln in lines if ln]

    if not lines:
        return ""

    def _is_noise_line(ln: str) -> bool:
        low = ln.lower()
        if low.startswith("gewicht"):
            return True
        if "dimension" in low or "dimensio" in low:
            return True
        if "farbe" in low:
            return True
        return False

    def _score_line(ln: str) -> int:
        low = ln.lower()
        score = 0

        # bevorzugt: enthält Buchstaben + Ziffern (typisch für Kürzel)
        if re.search(r"[A-Za-z]", ln) and re.search(r"\d", ln):
            score += 3

        # typische OBO-Token geben Bonus (nach Bedarf erweiterbar)
        if re.search(r"\b(FS|FT|VS|R1|R2|R3|LG|RB|LB|RAA|TSG|TS)\b", ln):
            score += 3

        # ":" ist oft Metainfo ("Gewicht:") -> Malus
        if ":" in ln:
            score -= 3

        # "für" kommt oft im Langtext vor -> Malus (wir schneiden später zwar ab, aber als Auswahlkriterium)
        if " für " in f" {low} ":
            score -= 1

        # sehr lange Sätze sind eher Beschreibung als Kürzel -> Malus
        if len(ln) > 45:
            score -= 2

        return score

    candidates = [ln for ln in lines if not _is_noise_line(ln)]
    if not candidates:
        candidates = lines  # Notfall: irgendwas nehmen

    best = max(candidates, key=_score_line)

    # Alles ab "für" entfernen
    m = re.search(r"\s+für\s+", best, flags=re.IGNORECASE)
    if m:
        best = best[:m.start()].strip()

    return re.sub(r"\s+", " ", best).strip()

def export_pn_ugl(
    df: pd.DataFrame,
    pdf_source=None,
    projekt_text: str = "",
    angebot_ref: str = "",
) -> tuple[bytes, str, str]:
    """Erzeugt UGL 5.0 Bestellung (350 Zeichen pro Zeile + CR/LF) für PN Handwerk."""

    # Defaults (ohne UI): Dokumentdatum heute, Lieferdatum +7 Tage
    today = pd.Timestamp.now(tz=None).strftime("%Y%m%d")
    lieferdatum = (pd.Timestamp.now(tz=None) + pd.Timedelta(days=7)).strftime("%Y%m%d")

    kundennr = None
    vorgang = None
    if _storage_obj_exists(pdf_source):
        kundennr = _pn_extract_kundennr_from_pdf(pdf_source)
        vorgang = _pn_extract_projektnr_from_pdf(pdf_source)

    vorgang = (vorgang or angebot_ref or "")[:15]

    # --- [NEU] PN/Access-sicher: Projekttext stärker begrenzen (Access-Feld ist offenbar kürzer als 50) ---
    projekt_text = "" if projekt_text is None else str(projekt_text)
    projekt_text = projekt_text.replace("\r", " ").replace("\n", " ").strip()
    projekt_text = projekt_text[:30]  # <= WICHTIG: PN-Importtable scheint kleiner als UGL-Spec zu sein


    # --- Projekttext automatisch aus PDF ziehen, falls leer ---
    if (not projekt_text) and _storage_obj_exists(pdf_source):
        projekt_text = _extract_projectname_from_pdf(pdf_source) or ""

    # --- KOP-Felder für PN bestmöglich befüllen ---
    angebot_ref = (angebot_ref or "").strip()

    # 41–90 (50): gut lesbar für PN (Projektname + Angebotsnr)
    kundenauftragstext = " / ".join([p for p in [angebot_ref, projekt_text.strip()] if p]).strip()
    kundenauftragstext = kundenauftragstext.replace("\r", " ").replace("\n", " ").strip()


    # 91–105 (15): Vorgangsnummer GH (wir packen Angebotsref rein, falls vorhanden)
    gh_vorgang = angebot_ref[:15] if angebot_ref else ""

    # 211–220 (10): Kommission in UGL ist fix 10 Zeichen → wir nehmen Projektnr als Kürzel
    kommission_ugl = (vorgang or angebot_ref or "")[:10]

    lines: list[str] = []

    # --- KOP ---
    kop = _pn_make_line_350()
    _pn_write_field(kop, 1, 3, "KOP")
    _pn_write_field(kop, 4, 10, kundennr, align="left", pad=" ")
    # 14–23: Lieferantennr absichtlich leer (PN-Spezial: verhindert Prefix wie OBO0000…)
    _pn_write_field(kop, 24, 2, "BE")

    _pn_write_field(kop, 26, 15, vorgang, align="left", pad=" ")
    _pn_write_field(kop, 41, 50, kundenauftragstext, align="left", pad=" ")

    # [NEU] extra Felder füllen (Mapping-Test)
    # _pn_write_field(kop, 91, 15, gh_vorgang, align="left", pad=" ")
    # _pn_write_field(kop, 211, 10, kommission_ugl, align="left", pad=" ")

    _pn_write_field(kop, 106, 8, lieferdatum, align="right", pad="0")
    _pn_write_field(kop, 114, 3, "EUR")
    _pn_write_field(kop, 117, 5, "05.00")
    _pn_write_field(kop, 162, 8, today, align="right", pad="0")
    lines.append(_pn_line_to_str(kop))

    # --- POA ---
    tmp = (df.copy() if df is not None else pd.DataFrame())

    # Pflichtspalten sicherstellen
    for col in ["Artikelnummer", "Bezeichnung", "Menge", "Preis"]:
        if col not in tmp.columns:
            tmp[col] = pd.NA

    tmp["Artikelnummer"] = tmp["Artikelnummer"].astype(str)
    tmp["Bezeichnung"] = tmp["Bezeichnung"].astype(str).fillna("")
    tmp["Menge"] = pd.to_numeric(tmp["Menge"], errors="coerce").fillna(0.0)
    tmp["Preis"] = pd.to_numeric(tmp["Preis"], errors="coerce").fillna(0.0)

    # --- [NEU] Platzhalter-Zeilen wie in Excel rausfiltern (z.B. Bezeichnung = "?") ---
    tmp["_bez_norm"] = (
        tmp["Bezeichnung"]
        .astype(str)
        .str.replace(r"\s+", " ", regex=True)
        .str.strip()
    )
    tmp["_art_pn"] = tmp["Artikelnummer"].map(_pn_clean_artnr_for_pn).astype(str).str.strip()

    # Filter: Bezeichnung "?" / leer / "—" / "-" raus + leere Artikelnummer raus
    tmp = tmp[
        (~tmp["_bez_norm"].isin({"?", "", "—", "-"})) &
        (tmp["_art_pn"].str.len() > 0)
    ].copy()

    # --- [NEU] Sortierung nach Artikelnummer (numerisch aufsteigend) ---
    tmp["_art_sort"] = pd.to_numeric(tmp["_art_pn"], errors="coerce")
    tmp = tmp.sort_values(by="_art_sort", ascending=True, na_position="last")

    # --- [FIX] Einheit-Fallback aus Datanorm (df_dn) vorbereiten ---
    dn_unit_map: dict[str, str] = {}

    try:
        _df_dn = globals().get("df_dn")

        if isinstance(_df_dn, pd.DataFrame) and not _df_dn.empty:
            if "Artikelnummer" in _df_dn.columns and "Einheit" in _df_dn.columns:
                for _r in _df_dn[["Artikelnummer", "Einheit"]].itertuples(index=False):
                    k = _pn_clean_artnr_for_pn(getattr(_r, "Artikelnummer", ""))
                    v = getattr(_r, "Einheit", "")

                    if k and v:
                        dn_unit_map[k] = str(v).strip()
    except Exception:
        dn_unit_map = {}

    # --- [NEU] UGL-Bezeichnung mit Angebotsnummer + kurzem Projektnamen ergänzen ---
    def _pn_first_two_project_words(val: object) -> str:
        s = "" if val is None else str(val)
        s = s.replace("\r", " ").replace("\n", " ")
        s = re.sub(r"\s+", " ", s).strip()

        if not s:
            return ""

        words = s.split(" ")
        return " ".join(words[:2]).strip()


    angebot_ref_short = re.sub(r"\s+", " ", str(angebot_ref or "")).strip()
    projekt_short = _pn_first_two_project_words(projekt_text)

    pn_suffix_parts = [p for p in [angebot_ref_short, projekt_short] if p]
    pn_bez_suffix = f"({' - '.join(pn_suffix_parts)})" if pn_suffix_parts else ""


    for i, r in tmp.reset_index(drop=True).iterrows():
        posnr = str(i + 1).zfill(10)

        art = _pn_clean_artnr_for_pn(r.get("Artikelnummer"))
        art = _pn_pad_fixed(art, 15, align="left", pad=" ")

        # FIX: PN erwartet Menge als skaliertes Integer (Fixfeld).
        # Wir nehmen 2 Dezimalstellen (x100) statt x1000 → verhindert 61,83 → 61.830,00
        qty_int = _pn_int_scaled(r.get("Menge"), decimals=3)     # Menge * 100

        price_int = _pn_int_scaled(r.get("Preis"), decimals=2)   # Preis * 100

        # Netto-Positionswert (Cent) = Preis * Menge
        try:
            qty = Decimal(str(r.get("Menge", 0)).replace(",", "."))
            price = Decimal(str(r.get("Preis", 0)).replace(",", "."))
            net_int = int((price * qty * Decimal(100)).quantize(Decimal("1"), rounding="ROUND_HALF_UP"))
        except Exception:
            net_int = 0

        # Bezeichnung für PN:
        # 1) bevorzugt Kürzel-Spalte, wenn vorhanden
        # 2) sonst Kürzel aus Bezeichnung extrahieren (letzte Zeile, dann vor "für" abschneiden)
        # Spaltensuche robust (case-insensitiv + ein paar Varianten)
        colmap = {str(c).strip().lower(): c for c in tmp.columns}
        bez_source = None
        for key in ["kurzbezeichnung", "kürzel", "kuerzel", "artikelkürzel", "artikelkuerzel", "typ", "type", "kurzbez", "kurztext"]:
            if key in colmap:
                bez_source = colmap[key]
                break

        bez_raw = str(r.get(bez_source) or "").strip() if bez_source else ""
        if not bez_raw:
            bez_raw = _pn_extract_kuerzel_from_text(r.get("Bezeichnung"))

            def _pn_kuerzel_from_dn_text(text: object) -> str:
                """
                Nimmt Datanorm-Bezeichnung (mehrzeilig) und versucht daraus den besten Typ/Kürzel zu ziehen.
                Wichtig: ignoriert Zeilen wie "Gewicht:", "Mat.:", "Einheit:", "Dimension:".
                """
                s = "" if text is None else str(text)
                raw_lines = s.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                lines = [re.sub(r"\s+", " ", ln).strip() for ln in raw_lines]
                lines = [ln for ln in lines if ln]

                if not lines:
                    return ""

                def _is_noise(ln: str) -> bool:
                    low = ln.lower()
                    return (
                        low.startswith("gewicht") or
                        low.startswith("mat.:") or
                        low.startswith("einheit:") or
                        ("dimension" in low) or
                        ("dimensio" in low)
                    )

                def _score(ln: str) -> int:
                    score = 0
                    # Typ/Kürzel hat fast immer Buchstaben + Ziffern
                    if re.search(r"[A-Za-z]", ln) and re.search(r"\d", ln):
                        score += 4
                    # typische Tokens (bei OBO häufig)
                    if re.search(r"\b(FS|FT|VS|R1|R2|R3|LG|RB|LB|RAA|TSG|TS|GRM|GSV|GEV|AW|KSK)\b", ln):
                        score += 3
                    # sehr lange Sätze sind eher Beschreibung
                    if len(ln) > 50:
                        score -= 2
                    # ":" deutet auf Metazeile hin
                    if ":" in ln:
                        score -= 2
                    # "für ..." eher Beschreibung – wir schneiden später zwar, aber zur Auswahl Malus
                    if re.search(r"\s+für\s+", ln, flags=re.IGNORECASE):
                        score -= 1
                    return score

                candidates = [ln for ln in lines if not _is_noise(ln)]
                if not candidates:
                    candidates = lines

                best = max(candidates, key=_score)

                # "… für …" abschneiden
                m = re.search(r"\s+für\s+", best, flags=re.IGNORECASE)
                if m:
                    best = best[:m.start()].strip()

                return re.sub(r"\s+", " ", best).strip()

        # falls immer noch leer: letzte Rettung -> volle Bezeichnung (sollte praktisch nicht mehr passieren)
        if not bez_raw:
            bez_raw = str(r.get("Bezeichnung") or "")

        bez = re.sub(r"\s+", " ", str(bez_raw or "")).strip()

        # UGL/PN hat zwei Textfelder à 40 Zeichen.
        # Zeile 1 = Kurzbezeichnung
        # Zeile 2 = Angebots-/Projektinfo ohne Einrückung
        bez1 = bez[:40]

        if pn_bez_suffix:
            bez2 = pn_bez_suffix[:40]
        else:
            bez2 = ""

        poa = _pn_make_line_350()
        _pn_write_field(poa, 1, 3, "POA")
        _pn_write_field(poa, 4, 10, posnr, align="right", pad="0")
        _pn_write_field(poa, 14, 10, "0000000000", align="right", pad="0")
        _pn_write_field(poa, 24, 15, art, align="left", pad=" ")
        _pn_write_field(poa, 39, 11, str(max(0, int(qty_int))), align="right", pad="0")
        _pn_write_field(poa, 50, 40, bez1, align="left", pad=" ")
        _pn_write_field(poa, 90, 40, bez2, align="left", pad=" ")
        _pn_write_field(poa, 130, 11, str(max(0, int(price_int))), align="right", pad="0")
        _pn_write_field(poa, 141, 1, "0")
        _pn_write_field(poa, 142, 11, str(max(0, int(net_int))), align="right", pad="0")
        _pn_write_field(poa, 153, 5, "00000", align="right", pad="0")
        _pn_write_field(poa, 158, 5, "00000", align="right", pad="0")

        # --- [NEU] Einheit: zuerst aus Angebots-DF, sonst aus Datanorm ---
        unit_val = None
        if "Einheit" in tmp.columns:
            unit_val = r.get("Einheit")

        if unit_val is None or str(unit_val).strip() == "":
            unit_val = dn_unit_map.get(_pn_clean_artnr_for_pn(r.get("Artikelnummer")))

        _pn_write_field(poa, 184, 3, _pn_unit_code(unit_val))

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

    # --- Dateiname: Projektname + Angebotsnummer ---
    proj = re.sub(r"[^\w\-\s]", "", str(projekt_text or "")).strip()
    angeb = re.sub(r"[^\w\-\s]", "", str(angebot_ref or "")).strip()

    # Leerzeichen durch _ ersetzen (sauber für Windows)
    proj = re.sub(r"\s+", "_", proj)
    angeb = re.sub(r"\s+", "_", angeb)

    if proj and angeb:
        filename = f"{proj}_{angeb}"
    elif proj:
        filename = proj
    elif angeb:
        filename = angeb
    else:
        filename = "PN_Bestellung"

    return data, filename, "application/octet-stream"
