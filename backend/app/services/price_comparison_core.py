"""Pure business logic preserved from the original BEG Preisviewer.

The source of truth for this port is ``viewer.py`` at Git commit
``4ed988fdb49a4db355d7c2361dbcf8e272ae563d`` (13 May 2026).  The original
application mixed these calculations with Streamlit session state and cloud
storage.  This module keeps the DataFrame arithmetic and display semantics,
while making every former session-state input an explicit argument.

No persistence, authentication, HTTP, or Streamlit dependency belongs here.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

import pandas as pd

from app.services.price_comparison_pdf_parser import (
    extract_prices_from_pdf as _extract_prices_from_pdf_original,
)


SOURCE_PROVENANCE = {
    "repository_commit": "4ed988fdb49a4db355d7c2361dbcf8e272ae563d",
    "source_file": "viewer.py",
    "source_date": "2026-05-13",
    "original_pdf_parser_sha256": "700fd43a366ed4e8b4a6e116c56eae2a147aaec13aa566cf9f6a763ee8b1e139",
    "pdf_parser_revision": "validated-material-v3",
    "pdf_parser_sha256": "f8b7ddf67d1336128680b92381d75615e28becae72f51f54d9f264f7465a7dca",
}

# Filled with hashes of the AST-extracted original function source.  The map is
# deliberately machine-readable so future changes can run a focused parity
# audit without importing the legacy Streamlit application.
SOURCE_FUNCTION_SHA256: dict[str, str] = {
    "_apply_manual_prices_to_df": "3970641842b30c5e5ca703810db50c822a79cdefeb724a1127959b08429ead30",
    "_build_offer_pv_metrics_for_meta_cache": "62079ba429aa1b5444d84d8b957899e1eedb3ddbdddb7b013623b119e2c6de7a",
    "_build_offers_meta_df": "f9eb9cbb9c41201c0f926213bb5f1ac97fa10344f101c7f5a656cfc34c047003",
    "_build_tab1_datanorm_offer_df": "285d66790aada81dcfebd0e77089f68acdef8fd06f8ec1db6489433131e27736",
    "_build_tab1_net_price_suggestions_df": "d9eddc82beaf3ec8d224a560067d5598c76f600cb9de4372b63c76e2695d161a",
    "_classify_datanorm_article_cluster": "818470f0834ab64bb7968350d013f331a98661286b15d498dcbfa7860a703c82",
    "_coerce_reference_weight": "3912c4b6a26dc0e3dde21c824dbd59e80e58faaa0e38ad9b081775d33e219dfc",
    "_datanorm_cluster_search_text": "4c8c3122d7093733b28a7f45e206e9ea4668e84b57747f3d24ef3f71ec2bd982",
    "_default_reference_rows": "a06ee0f600010a871c9b7d10452e4ed2198dd37ecbf7f0ffb27425b2f20762f3",
    "_detect_datanorm_material": "85984b32105e8b0c60effd1690be463887b116e7b5916ea0e4d12ded7dba426a",
    "_manual_price_key": "2d4c9f4e0b8354de88e49e130e3e7af5e00833384d47aca7c6b1ba52aa618d39",
    "_manual_price_prefix": "09af6e4b7a01ca3f71ca19d4e4f8cf5c5d960311ced7e36613435c82a9eaf19f",
    "_manual_prices_for_source": "347a16ccee955597e353b9cc685d3474061e380be563acae3569dace235a11d1",
    "_normalize_reference_rows": "be635d404c8ae980f6d75ec617ffbeff3c65bd0af98ea5412d681d038d7e88ff",
    "_parse_reference_articles_text": "ab37ec0b27c22d62b1a62f27422b3c17b18c6f1509a1d942de424a980c5272da",
    "_preiseinheit_multiplier": "d9108a93e08670ccd33f23fcfb381dacaf2594a0d43dcf4586bd4b50e1ca254e",
    "_prepare_all_prices_for_current_runtime_settings": "8f5c468df0b73f7ba6615df61a2c0596c34d3c27dd9b918a767ddd30337e28d6",
    "_pv_bucket": "4a766d0a759424605138b623712467f455aef6dabc20bf7161f6fd39a1e67eeb",
    "_reference_rows_signature": "c6a669ad13fe716bc98693fe80f79399a0a0390b007bdb6d528f44b256bf7c91",
    "_reference_rows_to_articles": "b560a8fc9e95582ba6f401ae1a3789e948d5f972700397425a949b49e3286995",
    "_reference_rows_to_weight_map": "c337a653778eed094b53a5e19e154972bdb87f8e4f2cb08bc334ce84b7c06da1",
    "_to_decimal_eur": "430360d55617215b1bdc60c3296d5bca6cb9af7b1c5f7ae0fe6c393f467087ac",
    "clean_artnr": "8661635982a0cde1132e14b9ca5602dbe34c91c03a8a14ec9fa40b3952f7f155",
    "parse_datanorm_v4_text": "8f05fd4957b6155f9703a2c8f7fa2c9f7ae0f232b7c46d9780f0a2b736f9e7b6",
    "smart_float": "a8615358cff2676de505b1ecae6c2c59eb9efbe3e6ef55669c03ddfdf3ec15eb",
}


# Regex/heuristics copied from viewer.py.
PRICE_RE_DE = re.compile(r"\b\d{1,3}(?:\.\d{3})*,\d{2}\b")


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
    s = s.strip(" :.-|")
    if re.search(r"\bBEG\s+Badener\s+Elektro\s+GmbH\b", s, flags=re.IGNORECASE):
        return ""
    return s


def extract_prices_from_pdf(
    raw: bytes,
    *,
    source_name: str | None = None,
    cache_sig: str | None = None,
) -> pd.DataFrame:
    """Parse an offer PDF with the byte-for-byte preserved legacy parser."""

    return _extract_prices_from_pdf_original(
        raw,
        cache_sig=cache_sig,
        source_name=source_name,
    )


# ---------------------------------------------------------------------------
# Datanorm V4
# ---------------------------------------------------------------------------

DEFAULT_NET_PRICE_REFERENCE_ARTICLES = [
    "6047611", "6047638", "6047654", "6047689", "6047719", "6047735",
    "6036560", "6036564", "6036566", "6036568", "6036570", "6036572",
    "6036100", "6036104", "6036106", "6036108", "6036110", "6036113",
    "6341527", "6341535", "6341543", "6341551", "6341578", "6341586",
    "6341616", "6341624", "6420656", "6420680", "6420710", "6420745",
    "6420788", "6420826", "6418252",
]

DATANORM_CLUSTER_VERSION = 1
DATANORM_CLUSTER_ALL_OPTION = "Alle Cluster"
DATANORM_CLUSTER_FS = "Kabeltrassen FS / Befestigung / Stahlbauteile"
DATANORM_CLUSTER_FT = "Kabeltrassen FT"
DATANORM_CLUSTER_V2A = "Kabeltrassen V2A / Befestigung V2A"
DATANORM_CLUSTER_V4A = "Kabeltrassen V4A / Befestigung V4A"
DATANORM_CLUSTER_CHANNELS = "Brüstungskanäle / Zubehör / Sonderkanäle"
DATANORM_CLUSTER_UNDERFLOOR = "Unterflurkanäle / Einbaugeräte"
DATANORM_CLUSTER_OTHER = "Sonstige"
DATANORM_ARTICLE_CLUSTERS = [
    DATANORM_CLUSTER_FS,
    DATANORM_CLUSTER_FT,
    DATANORM_CLUSTER_V2A,
    DATANORM_CLUSTER_V4A,
    DATANORM_CLUSTER_CHANNELS,
    DATANORM_CLUSTER_UNDERFLOOR,
    DATANORM_CLUSTER_OTHER,
]

_DATANORM_CHANNEL_CODES = {"0610", "0614", "0616", "0618", "0620", "0630", "0640", "0645", "0650"}
_DATANORM_UNDERFLOOR_CODES = {"0810", "0815", "0817", "0822", "0825", "0826", "0827", "0828", "0829"}
_DATANORM_CABLE_CODES = {"0410", "0420", "0425", "0430", "0432", "0440", "0445", "0460"}
_DATANORM_FASTENING_CODES = {"0116", "0117", "0120", "0125", "0127", "0130", "0415"}
_DATANORM_SUPPORT_WORD_RE = re.compile(
    r"\b(BEFESTIG\w*|KLEMME|KLAMMER|HALTER|HALTERUNG|STIEL|AUSLEGER|KONSOLE|"
    r"TRÄGER|TRAEGER|PROFIL|SCHIENE|WINKEL|SCHRAUB|MUTTER|SCHEIBE|DÜBEL|DUEBEL|ANKER|BOLZEN)\b",
    flags=re.IGNORECASE,
)
_DATANORM_TOOL_WORD_RE = re.compile(
    r"\b(WERKZEUG|BOLZENSCHNEIDER|SCHNEIDWERKZEUG|MONTAGEWERKZEUG|SETZWERKZEUG|BOHRER|ZANGE)\b",
    flags=re.IGNORECASE,
)


def _to_decimal_eur(preis_str: str) -> Decimal:
    if preis_str is None:
        return Decimal('0')
    s = str(preis_str).strip().replace(',', '.')
    if not s:
        return Decimal('0')
    if '.' in s:
        return Decimal(s)
    return (Decimal(s) / Decimal('100')).quantize(Decimal('0.01'))


def _preiseinheit_multiplier(raw: str) -> Decimal:
    r = (raw or '').strip()
    if not r:
        return Decimal(1)
    try:
        n = int(r)
    except ValueError:
        return Decimal(1)
    if n in (0, 1, 2, 3):
        return (Decimal(10) ** n)
    return Decimal(n) if n > 0 else Decimal(1)


def _datanorm_cluster_search_text(*parts: object) -> str:
    raw = " ".join(str(p or "") for p in parts)
    raw = raw.replace(",", ".").replace("\n", " ")
    return re.sub(r"\s+", " ", raw).strip().upper()


def _detect_datanorm_material(kurz: str, bezeichnung: str, texte: list[str] | None = None) -> str:
    """
    Ermittelt die für die Clusterung relevante Material-/Oberflächenklasse.

    Fachliche Zuordnung nach aktueller BEG-Regel:
    - DD zählt zu FT.
    - G / galvanisch verzinkt zählt zu FS.
    - FSK SW bzw. FSK wird bewusst als Sonderfall behandelt.
    """
    short_search = _datanorm_cluster_search_text(kurz)
    headline_search = _datanorm_cluster_search_text(kurz, bezeichnung)
    search = _datanorm_cluster_search_text(kurz, bezeichnung, " ".join(texte or []))
    short_tokens = re.findall(r"[A-Z0-9]+", short_search)

    if re.search(r"\bFSK\b", search):
        return "FSK"
    if (
        re.search(r"\b(V4A|A4|1\.440|1\.457)\b", search)
        or any(token.endswith("V4A") or token.endswith("A4") for token in short_tokens)
    ):
        return "V4A"
    if (
        re.search(r"\b(V2A|A2|1\.430|1\.431)\b", search)
        or any(token.endswith("V2A") or token.endswith("A2") for token in short_tokens)
    ):
        return "V2A"
    if re.search(r"\bDD\b", short_search) or any(token.endswith("DD") for token in short_tokens):
        return "FT"
    if (
        re.search(r"\bALU\b", headline_search)
        or any(token.endswith("ALU") for token in short_tokens)
        or re.search(r"MAT\.:\s*ALUMINIUM\b", search)
    ):
        return "ALU"
    if re.search(r"\bFT\b", headline_search) or any(token.endswith("FT") for token in short_tokens):
        return "FT"
    if (
        "GALVANISCH VERZINKT" in search
        or re.search(r"\bG\b", short_search)
        or "G" in short_tokens
    ):
        return "FS"
    if re.search(r"\bFS\b", headline_search) or any(token.endswith("FS") for token in short_tokens):
        return "FS"
    return ""


def _classify_datanorm_article_cluster(
    warengruppe: str,
    kurz: str,
    bezeichnung: str,
    texte: list[str] | None = None,
) -> tuple[str, str, str]:
    """
    Ordnet OBO-Datanormartikel den Preisviewer-Clustern zu.

    Die Warengruppe ist der stabilste Anker. Material-/Oberflächenkürzel
    entscheiden erst innerhalb der Kabeltrassen- und Befestigungsgruppen.
    Spezialfälle wie FSK, Werkzeuge und 07xx gehen bewusst in Sonstige.
    """
    code = str(warengruppe or "").strip()
    material = _detect_datanorm_material(kurz, bezeichnung, texte)
    search = _datanorm_cluster_search_text(kurz, bezeichnung, " ".join(texte or []))

    if code.startswith("07") or material == "FSK" or _DATANORM_TOOL_WORD_RE.search(search):
        return DATANORM_CLUSTER_OTHER, material or "Sonstige", "sicher"

    if material == "ALU":
        return DATANORM_CLUSTER_CHANNELS, material, "sicher"

    if code in _DATANORM_CHANNEL_CODES:
        return DATANORM_CLUSTER_CHANNELS, material or "Kanal", "sicher"

    if code in _DATANORM_UNDERFLOOR_CODES:
        return DATANORM_CLUSTER_UNDERFLOOR, material or "Unterflur", "sicher"

    if code in _DATANORM_CABLE_CODES or code in _DATANORM_FASTENING_CODES:
        if material == "V4A":
            return DATANORM_CLUSTER_V4A, material, "sicher"
        if material == "V2A":
            return DATANORM_CLUSTER_V2A, material, "sicher"
        if (
            code in _DATANORM_CABLE_CODES
            and material == "FT"
            and not _DATANORM_SUPPORT_WORD_RE.search(search)
        ):
            return DATANORM_CLUSTER_FT, material, "sicher"
        return DATANORM_CLUSTER_FS, material or "FS", "sicher" if material else "prüfen"

    return DATANORM_CLUSTER_OTHER, material or "Sonstige", "sicher"


def parse_datanorm_v4_text(text: str) -> pd.DataFrame:
    articles = {}
    current_art = None

    for raw_line in text.splitlines():
        if not raw_line.strip():
            continue
        parts = raw_line.rstrip("\n").split(";")
        kind = parts[0]

        if kind == "A" and len(parts) >= 10:
            artnr = clean_artnr(parts[2])
            current_art = artnr
            bezeichnung = parts[4].strip() if len(parts) > 4 else ""
            preiskennz  = parts[6].strip() if len(parts) > 6 else ""
            preiseinh   = parts[7].strip() if len(parts) > 7 else "0"
            einheit     = parts[8].strip() if len(parts) > 8 else ""
            preis_raw   = parts[9].strip() if len(parts) > 9 else "0"
            warengruppe = parts[10].strip() if len(parts) > 10 else ""

            eur_pro_preiseinheit = _to_decimal_eur(preis_raw)
            faktor = _preiseinheit_multiplier(preiseinh)
            eur_pro_me = (eur_pro_preiseinheit / faktor).quantize(Decimal('0.0001'))

            articles[artnr] = {
                "Artikelnummer": artnr,
                "Texte": [bezeichnung] if bezeichnung else [],
                "DatanormWarengruppe": warengruppe,
                "Kurzbezeichnung": "",
                "Einheit": einheit,
                "Nettopreis": float(eur_pro_me),
                "Preiseinheit": preiseinh,
                "Preis (Roh € pro Preiseinheit)": float(eur_pro_preiseinheit),
                "Preis-Typ": ("Brutto" if preiskennz == "1" else ("Netto" if preiskennz == "2" else preiskennz or None)),
            }

        elif kind == "B" and len(parts) >= 4 and current_art:
            add = parts[3].strip()
            if add:
                articles[current_art]["Kurzbezeichnung"] = add
                articles[current_art]["Texte"].append(add)

        elif kind == "T" and current_art:
            for p in parts[4:]:
                p = (p or "").strip()
                if p and not re.fullmatch(r"\d{1,2}", p):
                    articles[current_art]["Texte"].append(p)

        elif kind == "C":
            current_art = None

    rows = []
    for a in articles.values():
        bezeichnung = "\n".join([t for t in a["Texte"] if t])
        cluster, material, cluster_sicherheit = _classify_datanorm_article_cluster(
            a.get("DatanormWarengruppe"),
            a.get("Kurzbezeichnung"),
            bezeichnung,
            a.get("Texte"),
        )
        rows.append({
            "Artikelnummer": a["Artikelnummer"],
            "Bezeichnung": bezeichnung,
            "Kurzbezeichnung": a.get("Kurzbezeichnung"),
            "DatanormWarengruppe": a.get("DatanormWarengruppe"),
            "DatanormMaterial": material,
            "Artikelcluster": cluster,
            "Cluster-Sicherheit": cluster_sicherheit,
            "Einheit": a["Einheit"],
            "Nettopreis": a["Nettopreis"],
            "Preiseinheit": a.get("Preiseinheit"),
            "Preis (Roh € pro Preiseinheit)": a.get("Preis (Roh € pro Preiseinheit)"),
            "Preis-Typ": a.get("Preis-Typ"),
        })

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values("Artikelnummer")
    return df


def parse_datanorm_bytes(raw: bytes) -> pd.DataFrame:
    """Decode and parse Datanorm V4 bytes using the legacy encoding order."""

    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")
    return parse_datanorm_v4_text(text)


# ---------------------------------------------------------------------------
# Weighted reference articles and net-price suggestions
# ---------------------------------------------------------------------------

def _parse_reference_articles_text(text: str) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for raw in re.split(r"[\s,;]+", str(text or "")):
        art = clean_artnr(raw)
        if not re.search(r"\d", art or "") or len(art) < 5:
            continue
        if art and art not in seen:
            seen.add(art)
            refs.append(art)
    return refs


def _coerce_reference_weight(value, default: float | None = 1.0) -> float | None:
    if isinstance(value, str):
        raw = value.strip().lower()
        if not raw or raw in {"none", "nan", "null"}:
            return default
        match = re.search(r"-?\d+(?:[.,]\d+)?", raw)
        if not match:
            return default
        weight = pd.to_numeric(match.group(0).replace(",", "."), errors="coerce")
    else:
        weight = pd.to_numeric(pd.Series([value]), errors="coerce").iloc[0]
    if pd.isna(weight) or float(weight) <= 0:
        return default
    return float(weight)


def _default_reference_rows() -> list[dict]:
    return [
        {"Artikelnummer": str(art), "Gewichtung": 1.0}
        for art in DEFAULT_NET_PRICE_REFERENCE_ARTICLES
    ]


def _normalize_reference_rows(rows) -> list[dict]:
    normalized: list[dict] = []
    seen: set[str] = set()
    if not isinstance(rows, list):
        return normalized

    for row in rows:
        if isinstance(row, dict):
            raw_art = row.get("Artikelnummer") or row.get("article") or row.get("art")
            raw_weight = row.get("Gewichtung", row.get("weight", 1.0))
        else:
            raw_art = row
            raw_weight = 1.0

        art = clean_artnr(raw_art)
        if not art or not re.search(r"\d", art) or len(art) < 5 or art in seen:
            continue

        weight = _coerce_reference_weight(raw_weight, default=None)
        if weight is None:
            continue

        seen.add(art)
        normalized.append({"Artikelnummer": art, "Gewichtung": weight})
    return normalized


def _reference_rows_to_articles(rows: list[dict]) -> list[str]:
    return [str(row["Artikelnummer"]) for row in _normalize_reference_rows(rows)]


def _reference_rows_to_weight_map(rows: list[dict]) -> dict[str, float]:
    return {
        str(row["Artikelnummer"]): float(row["Gewichtung"])
        for row in _normalize_reference_rows(rows)
    }


def _reference_rows_signature(rows: list[dict]) -> str:
    return json.dumps(_normalize_reference_rows(rows), sort_keys=True, ensure_ascii=False)


def _build_tab1_net_price_suggestions_df(
    df_dn: pd.DataFrame,
    all_prices: pd.DataFrame,
    reference_rows: list[dict],
) -> tuple[pd.DataFrame, dict]:
    reference_rows = _normalize_reference_rows(reference_rows)
    reference_articles = _reference_rows_to_articles(reference_rows)
    reference_weight_map = _reference_rows_to_weight_map(reference_rows)

    out_cols = [
        "Artikelnummer",
        "Bezeichnung",
        "Artikelcluster",
        "Cluster-Sicherheit",
        "Medianangebotspreis",
        "Preisvergleich",
        "Aktueller Nettopreis",
        "Vorschlag Nettopreis",
    ]

    if (
        not isinstance(df_dn, pd.DataFrame)
        or df_dn.empty
        or not {"Artikelnummer", "Bezeichnung", "Nettopreis"}.issubset(df_dn.columns)
        or not isinstance(all_prices, pd.DataFrame)
        or all_prices.empty
        or "Artikelnummer" not in all_prices.columns
    ):
        return pd.DataFrame(columns=out_cols), {
            "reference_ratio": None,
            "reference_deviation_pct": None,
            "reference_articles": reference_articles,
            "reference_articles_valid": [],
            "eligible_article_count": 0,
        }

    dn_cols = ["Artikelnummer", "Bezeichnung", "Nettopreis"]
    for optional_col in ["Artikelcluster", "Cluster-Sicherheit"]:
        if optional_col in df_dn.columns:
            dn_cols.append(optional_col)

    dn = df_dn[dn_cols].copy()
    for optional_col in ["Artikelcluster", "Cluster-Sicherheit"]:
        if optional_col not in dn.columns:
            dn[optional_col] = ""
    dn["Artikelnummer"] = dn["Artikelnummer"].astype(str).map(clean_artnr)
    dn["Aktueller Nettopreis"] = pd.to_numeric(dn["Nettopreis"], errors="coerce")
    dn = dn.dropna(subset=["Artikelnummer"]).drop_duplicates("Artikelnummer", keep="first")

    prices = all_prices.copy()
    prices["Artikelnummer"] = prices["Artikelnummer"].astype(str).map(clean_artnr)
    prices["Datum"] = pd.to_datetime(prices.get("Datum"), errors="coerce")
    prices["Angebotsart"] = prices.get("Angebotsart", "Erstangebot")
    prices["Angebotsart"] = prices["Angebotsart"].fillna("Erstangebot").astype(str)

    price_source_col = "Preis_raw" if "Preis_raw" in prices.columns else "Preis"
    prices["_angebotspreis_basis"] = pd.to_numeric(prices.get(price_source_col), errors="coerce")

    cutoff = pd.Timestamp.now(tz=None).normalize() - pd.DateOffset(months=24)
    prices = prices[
        prices["Datum"].ge(cutoff)
        & prices["Angebotsart"].eq("Erstangebot")
        & pd.notna(prices["_angebotspreis_basis"])
        & (prices["_angebotspreis_basis"] > 0)
        & prices["Artikelnummer"].astype(str).str.len().gt(0)
    ].copy()

    if prices.empty:
        return pd.DataFrame(columns=out_cols), {
            "reference_ratio": None,
            "reference_deviation_pct": None,
            "reference_articles": reference_articles,
            "reference_articles_valid": [],
            "eligible_article_count": 0,
        }

    stats = (
        prices.groupby("Artikelnummer", as_index=False)
        .agg(
            Medianangebotspreis=("_angebotspreis_basis", "median"),
            _Anzahl_Angebotspreise=("_angebotspreis_basis", "count"),
        )
    )
    stats = stats[stats["_Anzahl_Angebotspreise"] >= 5].copy()

    merged = dn.merge(stats, on="Artikelnummer", how="inner")
    merged = merged[
        pd.notna(merged["Aktueller Nettopreis"])
        & (merged["Aktueller Nettopreis"] > 0)
        & pd.notna(merged["Medianangebotspreis"])
        & (merged["Medianangebotspreis"] > 0)
    ].copy()

    if merged.empty:
        return pd.DataFrame(columns=out_cols), {
            "reference_ratio": None,
            "reference_deviation_pct": None,
            "reference_articles": reference_articles,
            "reference_articles_valid": [],
            "eligible_article_count": 0,
        }

    reference_set = set(reference_articles)
    ref_rows = merged[merged["Artikelnummer"].isin(reference_set)].copy()
    ref_rows["_reference_ratio"] = ref_rows["Medianangebotspreis"] / ref_rows["Aktueller Nettopreis"]
    ref_rows["_reference_weight"] = (
        ref_rows["Artikelnummer"]
        .astype(str)
        .map(reference_weight_map)
        .map(lambda value: _coerce_reference_weight(value, default=1.0))
    )
    ref_rows = ref_rows[
        pd.notna(ref_rows["_reference_ratio"])
        & (ref_rows["_reference_ratio"] > 0)
        & pd.notna(ref_rows["_reference_weight"])
        & (ref_rows["_reference_weight"] > 0)
    ].copy()

    if not ref_rows.empty:
        reference_ratio = float(
            (ref_rows["_reference_ratio"] * ref_rows["_reference_weight"]).sum()
            / ref_rows["_reference_weight"].sum()
        )
    else:
        reference_ratio = None
    reference_deviation_pct = ((reference_ratio - 1.0) * 100.0) if reference_ratio else None

    if reference_ratio and reference_ratio > 0:
        merged["Vorschlag Nettopreis"] = merged["Medianangebotspreis"] / reference_ratio
        orientation_ratio = merged["Aktueller Nettopreis"] / merged["Vorschlag Nettopreis"]
        merged["Preisvergleich"] = "🔴 Nettopreis schlecht"
        merged.loc[orientation_ratio.lt(1.15), "Preisvergleich"] = "🟡 Nettopreis mittel"
        merged.loc[orientation_ratio.le(1.05), "Preisvergleich"] = "🟢 Nettopreis gut"
    else:
        merged["Vorschlag Nettopreis"] = pd.NA
        merged["Preisvergleich"] = "Keine Referenzbasis"

    result = merged[out_cols].sort_values(
        ["Preisvergleich", "Artikelnummer"],
        ascending=[True, True],
    ).reset_index(drop=True)

    meta = {
        "reference_ratio": reference_ratio,
        "reference_deviation_pct": reference_deviation_pct,
        "reference_articles": reference_articles,
        "reference_rows": reference_rows,
        "reference_articles_valid": ref_rows["Artikelnummer"].dropna().astype(str).tolist(),
        "reference_weight_total": float(ref_rows["_reference_weight"].sum()) if not ref_rows.empty else 0.0,
        "eligible_article_count": int(len(result)),
        "minimum_offer_prices": 5,
        "months_back": 24,
    }
    return result, meta


parse_reference_articles_text = _parse_reference_articles_text
coerce_reference_weight = _coerce_reference_weight
default_reference_rows = _default_reference_rows
normalize_reference_rows = _normalize_reference_rows


def suggestions(
    df_dn: pd.DataFrame,
    prices: pd.DataFrame,
    reference_rows: list[dict],
) -> tuple[pd.DataFrame, dict]:
    """Return the original weighted 24-month net-price suggestions."""

    return _build_tab1_net_price_suggestions_df(df_dn, prices, reference_rows)


# ---------------------------------------------------------------------------
# Runtime price preparation (explicit former session-state inputs)
# ---------------------------------------------------------------------------

def _manual_price_key(source: object, article: object) -> str:
    return f"{str(source or '').strip()}||{clean_artnr(article)}"


def _manual_price_prefix(source: object) -> str:
    return f"{str(source or '').strip()}||"


def _manual_prices_for_source(manual_store: dict | None, source: object) -> dict[str, float]:
    if not isinstance(manual_store, dict) or not manual_store:
        return {}
    prefix = _manual_price_prefix(source)
    return {
        str(k): v
        for k, v in manual_store.items()
        if str(k).startswith(prefix)
    }


def _apply_manual_prices_to_df(
    df: pd.DataFrame,
    manual_store: dict | None,
    source_col: str = "Quelle",
    article_col: str = "Artikelnummer",
    price_col: str = "Preis",
) -> pd.DataFrame:
    if not isinstance(df, pd.DataFrame) or df.empty:
        return df
    if source_col not in df.columns or article_col not in df.columns or price_col not in df.columns:
        return df

    if not isinstance(manual_store, dict) or not manual_store:
        if "Preis_manuell" not in df.columns:
            df["Preis_manuell"] = False
        else:
            df["Preis_manuell"] = False
        return df

    keys = (
        df[source_col].astype(str).str.strip()
        + "||"
        + df[article_col].astype(str).map(clean_artnr)
    )
    manual_values = pd.to_numeric(keys.map(manual_store), errors="coerce")
    mask_manual = pd.notna(manual_values)

    df["Preis_manuell"] = mask_manual
    df.loc[mask_manual, price_col] = manual_values.loc[mask_manual].astype(float)
    return df


manual_price_key = _manual_price_key
manual_prices_for_source = _manual_prices_for_source
apply_manual_prices = _apply_manual_prices_to_df


def _prepare_all_prices_for_current_runtime_settings(
    all_prices: pd.DataFrame,
    df_dn: pd.DataFrame | None,
    discounts: Mapping[str, float] | None = None,
    align_netto: Mapping[str, bool] | None = None,
    manual_prices: dict | None = None,
) -> pd.DataFrame:
    if all_prices is None or all_prices.empty:
        return pd.DataFrame()

    df = all_prices.copy()

    if "Quelle" not in df.columns or "Artikelnummer" not in df.columns:
        return df

    df["Quelle"] = df["Quelle"].astype(str)
    df["Artikelnummer"] = df["Artikelnummer"].astype(str).map(clean_artnr)

    if "Preis_raw" in df.columns:
        df["Preis_basis"] = pd.to_numeric(df["Preis_raw"], errors="coerce")
    else:
        df["Preis_basis"] = pd.to_numeric(df.get("Preis"), errors="coerce")

    align_store = align_netto or {}
    align_sources = {str(q) for q, active in align_store.items() if bool(active)}

    if (
        align_sources
        and isinstance(df_dn, pd.DataFrame)
        and not df_dn.empty
        and {"Artikelnummer", "Nettopreis"}.issubset(df_dn.columns)
    ):
        dn_net = df_dn[["Artikelnummer", "Nettopreis"]].copy()
        dn_net["Artikelnummer"] = dn_net["Artikelnummer"].astype(str).map(clean_artnr)
        dn_net = dn_net.dropna(subset=["Artikelnummer"]).drop_duplicates(
            subset=["Artikelnummer"],
            keep="first",
        )

        df = df.merge(
            dn_net.rename(columns={"Nettopreis": "_dn_nettopreis_runtime"}),
            on="Artikelnummer",
            how="left",
        )

        df["_dn_nettopreis_runtime"] = pd.to_numeric(
            df["_dn_nettopreis_runtime"],
            errors="coerce",
        )

        mask_align = (
            df["Quelle"].isin(align_sources)
            & pd.notna(df["Preis_basis"])
            & pd.notna(df["_dn_nettopreis_runtime"])
            & (df["_dn_nettopreis_runtime"] > 0)
            & (df["_dn_nettopreis_runtime"] < df["Preis_basis"])
        )

        df.loc[mask_align, "Preis_basis"] = df.loc[mask_align, "_dn_nettopreis_runtime"]
        df.drop(columns=["_dn_nettopreis_runtime"], inplace=True, errors="ignore")

    discount_store = discounts or {}
    df["Rabatt_%"] = pd.to_numeric(
        df["Quelle"].map(lambda q: float(discount_store.get(str(q), 0.0))),
        errors="coerce",
    ).fillna(0.0)

    df["Preis"] = (
        pd.to_numeric(df["Preis_basis"], errors="coerce")
        * (1.0 - (df["Rabatt_%"] / 100.0))
    )

    df = _apply_manual_prices_to_df(df, manual_prices or {})
    return df


def prepare_prices(
    all_prices: pd.DataFrame,
    df_dn: pd.DataFrame | None,
    discounts: Mapping[str, float] | None,
    align_netto: Mapping[str, bool] | None,
    manual_prices: dict | None,
    offer_types: Mapping[str, str] | None,
) -> pd.DataFrame:
    """Prepare the runtime price view in the legacy operation order.

    Operation order is significant: Datanorm net alignment, discount, then
    manual price.  Offer types default to ``Erstangebot``.
    """

    if all_prices is None or all_prices.empty:
        return pd.DataFrame()
    raw = all_prices.copy()
    if "Quelle" in raw.columns:
        type_store = offer_types or {}
        raw["Angebotsart"] = raw["Quelle"].map(
            lambda q: str(type_store.get(str(q), "Erstangebot"))
        )
    if "Preis_raw" not in raw.columns and "Preis" in raw.columns:
        raw["Preis_raw"] = pd.to_numeric(raw["Preis"], errors="coerce")

    prepared = _prepare_all_prices_for_current_runtime_settings(
        raw,
        df_dn,
        discounts=discounts,
        align_netto=align_netto,
        manual_prices=manual_prices,
    )
    if "Rabatt_%" in prepared.columns:
        prepared["Rabattiert"] = prepared["Rabatt_%"] > 0
    return prepared


# ---------------------------------------------------------------------------
# Datanorm/offer comparison
# ---------------------------------------------------------------------------

def _build_tab1_datanorm_offer_df(
    df_dn: pd.DataFrame,
    all_prices: pd.DataFrame,
    discounts: Mapping[str, float] | None = None,
    align_netto: Mapping[str, bool] | None = None,
) -> pd.DataFrame:
    df_show_tab1 = df_dn.copy() if isinstance(df_dn, pd.DataFrame) else pd.DataFrame()

    if df_show_tab1.empty:
        return df_show_tab1

    if all_prices is not None and isinstance(all_prices, pd.DataFrame) and not all_prices.empty:
        ap = all_prices.dropna(subset=["Artikelnummer"]).copy()

        if not ap.empty:
            ap["Artikelnummer"] = ap["Artikelnummer"].astype(str).map(clean_artnr)

            if "Preis_raw" in ap.columns:
                ap["_tab1_preis_basis"] = pd.to_numeric(ap["Preis_raw"], errors="coerce")
            else:
                ap["_tab1_preis_basis"] = pd.to_numeric(ap.get("Preis"), errors="coerce")

            align_store = align_netto or {}
            align_sources = {str(q) for q, active in align_store.items() if bool(active)}

            if (
                align_sources
                and isinstance(df_dn, pd.DataFrame)
                and not df_dn.empty
                and {"Artikelnummer", "Nettopreis"}.issubset(df_dn.columns)
            ):
                dn_net = df_dn[["Artikelnummer", "Nettopreis"]].copy()
                dn_net["Artikelnummer"] = dn_net["Artikelnummer"].astype(str).map(clean_artnr)
                dn_net = dn_net.dropna(subset=["Artikelnummer"]).drop_duplicates(
                    subset=["Artikelnummer"],
                    keep="first",
                )

                ap = ap.merge(
                    dn_net.rename(columns={"Nettopreis": "_tab1_dn_nettopreis"}),
                    on="Artikelnummer",
                    how="left",
                )

                ap["_tab1_dn_nettopreis"] = pd.to_numeric(
                    ap["_tab1_dn_nettopreis"], errors="coerce"
                )

                mask_align = (
                    ap["Quelle"].astype(str).isin(align_sources)
                    & pd.notna(ap["_tab1_preis_basis"])
                    & pd.notna(ap["_tab1_dn_nettopreis"])
                    & (ap["_tab1_dn_nettopreis"] > 0)
                    & (ap["_tab1_dn_nettopreis"] < ap["_tab1_preis_basis"])
                )

                ap.loc[mask_align, "_tab1_preis_basis"] = ap.loc[
                    mask_align, "_tab1_dn_nettopreis"
                ]
                ap.drop(columns=["_tab1_dn_nettopreis"], inplace=True, errors="ignore")

            discount_store = discounts or {}
            ap["_tab1_rabatt_pct"] = pd.to_numeric(
                ap["Quelle"].map(lambda q: float(discount_store.get(str(q), 0.0))),
                errors="coerce",
            ).fillna(0.0)

            ap["_tab1_preis"] = (
                pd.to_numeric(ap["_tab1_preis_basis"], errors="coerce")
                * (1.0 - (ap["_tab1_rabatt_pct"] / 100.0))
            )

            ap = ap.dropna(subset=["Artikelnummer", "_tab1_preis"]).copy()

            if not ap.empty:
                sort_cols = ["Artikelnummer"]
                ascending = [True]
                if "Datum" in ap.columns:
                    ap["Datum"] = pd.to_datetime(ap["Datum"], errors="coerce")
                    sort_cols.append("Datum")
                    ascending.append(False)

                ap = ap.sort_values(sort_cols, ascending=ascending)
                ap["rank"] = ap.groupby("Artikelnummer").cumcount()
                ap_top5 = ap[ap["rank"] < 5].copy()

                ap_pivot_price = (
                    ap_top5
                    .pivot(index="Artikelnummer", columns="rank", values="_tab1_preis")
                    .reset_index()
                    .rename(columns={
                        0: "Angebotspreis 1",
                        1: "Angebotspreis 2",
                        2: "Angebotspreis 3",
                        3: "Angebotspreis 4",
                        4: "Angebotspreis 5",
                    })
                )

                ap_pivot_src = (
                    ap_top5
                    .pivot(index="Artikelnummer", columns="rank", values="Quelle")
                    .reset_index()
                    .rename(columns={
                        0: "AP1_src",
                        1: "AP2_src",
                        2: "AP3_src",
                        3: "AP4_src",
                        4: "AP5_src",
                    })
                )

                for dfp in (ap_pivot_price, ap_pivot_src):
                    dfp["Artikelnummer"] = dfp["Artikelnummer"].astype(str).map(clean_artnr)
                    df_show_tab1["Artikelnummer"] = (
                        df_show_tab1["Artikelnummer"].astype(str).map(clean_artnr)
                    )
                    df_show_tab1 = df_show_tab1.merge(dfp, on="Artikelnummer", how="left")

                for i in range(1, 6):
                    src_col = f"AP{i}_src"
                    flag_col = f"AP{i}_disc"
                    if src_col in df_show_tab1.columns:
                        df_show_tab1[flag_col] = df_show_tab1[src_col].fillna("").map(
                            lambda s: bool(discount_store.get(str(s).strip(), 0) > 0)
                        )

                for c in [
                    "Angebotspreis 1", "Angebotspreis 2", "Angebotspreis 3",
                    "Angebotspreis 4", "Angebotspreis 5",
                ]:
                    if c in df_show_tab1.columns:
                        df_show_tab1[c] = pd.to_numeric(df_show_tab1[c], errors="coerce")

                for c in ["AP1_src", "AP2_src", "AP3_src", "AP4_src", "AP5_src"]:
                    if c not in df_show_tab1.columns:
                        df_show_tab1[c] = ""
                    else:
                        df_show_tab1[c] = df_show_tab1[c].fillna("").astype(str)

                df_show_tab1["AP_best_src"] = df_show_tab1[
                    ["AP1_src", "AP2_src", "AP3_src", "AP4_src", "AP5_src"]
                ].apply(
                    lambda r: next((x for x in r if isinstance(x, str) and x.strip()), ""),
                    axis=1,
                )

    for col in ["Preiseinheit", "Preis (Roh € pro Preiseinheit)"]:
        if col in df_show_tab1.columns:
            df_show_tab1.drop(columns=[col], inplace=True)

    aktuell_cols = [c for c in df_show_tab1.columns if c.endswith(" (aktuell)")]
    if aktuell_cols:
        df_show_tab1.drop(columns=aktuell_cols, inplace=True)

    if "Letzter_Preis" in df_show_tab1.columns:
        df_show_tab1.drop(columns=["Letzter_Preis"], inplace=True)

    return df_show_tab1


def datanorm_comparison(
    df_dn: pd.DataFrame,
    prices: pd.DataFrame,
    discounts: Mapping[str, float] | None,
    align_netto: Mapping[str, bool] | None,
) -> pd.DataFrame:
    """Build the original five-most-recent Datanorm/offer comparison."""

    return _build_tab1_datanorm_offer_df(df_dn, prices, discounts, align_netto)


# ---------------------------------------------------------------------------
# Offer metadata and historical percentage metrics
# ---------------------------------------------------------------------------

def _storage_mtime(obj: Any) -> float:
    try:
        st_obj = obj.stat()
        st_mtime = getattr(st_obj, "st_mtime", None)
        if st_mtime is not None:
            return float(st_mtime)
    except Exception:
        pass
    try:
        mtime = getattr(obj, "mtime", None)
        if mtime is not None:
            return float(mtime)
    except Exception:
        pass
    if isinstance(obj, Mapping):
        try:
            return float(obj.get("mtime", obj.get("upload_ts", 0.0)) or 0.0)
        except Exception:
            pass
    return 0.0


def _storage_name(obj: Any) -> str:
    if isinstance(obj, Mapping):
        return str(obj.get("name", obj.get("Quelle", "")))
    return getattr(obj, "name", Path(str(obj)).name)


def _build_offers_meta_df(
    all_prices: pd.DataFrame,
    saved_pdfs: Sequence[Any],
    offer_type_store: Mapping[str, str] | None,
) -> pd.DataFrame:
    def nunique_positions(series: pd.Series) -> int:
        s = series.dropna().astype(str).replace({"": pd.NA, "None": pd.NA})
        return int(s.nunique())

    df = all_prices.copy()

    for _c in ["Gesamt (netto)", "Gesamt (brutto)"]:
        if _c not in df.columns:
            df[_c] = pd.NA

    meta = (
        df.groupby("Quelle", as_index=False)
          .agg(
              Datum=("Datum", "max"),
              Projekt=("Projekt", lambda s: next((x for x in s if pd.notna(x) and str(x).strip()), None)),
              Anbieter=("Anbieter", "first"),
              Angebot=("Angebot", "first"),
              Pos_Anzahl=("Artikelnummer", nunique_positions),
              Gesamt_netto=("Gesamt (netto)", lambda s: pd.to_numeric(s, errors="coerce").max()),
              Gesamt_brutto=("Gesamt (brutto)", lambda s: pd.to_numeric(s, errors="coerce").max()),
          )
    )

    offer_type_store = offer_type_store or {}
    meta["Angebotsart"] = meta["Quelle"].map(
        lambda q: str(offer_type_store.get(q, "Erstangebot"))
    )

    meta["Projekt"] = meta["Projekt"].apply(_clean_project_name).replace("", pd.NA).fillna("—")

    upload_ts_map = {
        str(_storage_name(p)): float(_storage_mtime(p))
        for p in saved_pdfs
    }

    meta["Upload_ts"] = meta["Quelle"].map(
        lambda name: float(upload_ts_map.get(str(name), 0.0))
    )
    meta["Upload"] = pd.to_datetime(meta["Upload_ts"], unit="s", errors="coerce")

    meta = meta.sort_values("Upload_ts", ascending=False).reset_index(drop=True)
    return meta


def build_offers_meta(
    all_prices: pd.DataFrame,
    saved_pdfs: Sequence[Any],
    offer_types: Mapping[str, str] | None,
) -> pd.DataFrame:
    return _build_offers_meta_df(all_prices, saved_pdfs, offer_types)


def _pv_bucket(p: float) -> str:
    if p >= 25.0:
        return "🟥"
    if p >= 10.0:
        return "🟧"
    if p > -10.0:
        return "🟨"
    if p > -25.0:
        return "🟩️"
    return "🟩🟩"


def _build_offer_pv_metrics_for_meta_cache(
    all_prices: pd.DataFrame,
    window_days: int = 365,
    quellen: list[str] | None = None,
) -> pd.DataFrame:
    if all_prices is None or all_prices.empty:
        return pd.DataFrame(columns=["Quelle", "PV_avg_pct_pos", "PV_avg_pct_wert"])

    _now = pd.Timestamp.now(tz=None).normalize()
    _cut = _now - pd.Timedelta(days=window_days)

    hist = all_prices.copy()
    hist["Quelle"] = hist["Quelle"].astype(str)
    hist["Artikelnummer"] = hist["Artikelnummer"].astype(str).map(clean_artnr)
    hist["Datum"] = pd.to_datetime(hist["Datum"], errors="coerce")
    hist["Preis"] = pd.to_numeric(hist["Preis"], errors="coerce")

    hist = hist[
        hist["Datum"].ge(_cut)
        & hist["Datum"].le(_now)
        & pd.notna(hist["Preis"])
    ].copy()

    if hist.empty:
        return pd.DataFrame(columns=["Quelle", "PV_avg_pct_pos", "PV_avg_pct_wert"])

    if "Angebotsart" in hist.columns:
        hist["Angebotsart"] = hist["Angebotsart"].fillna("Erstangebot").astype(str)
        hist_ref_base = hist[hist["Angebotsart"].eq("Erstangebot")].copy()
    else:
        hist_ref_base = hist.copy()

    if hist_ref_base.empty:
        return pd.DataFrame(columns=["Quelle", "PV_avg_pct_pos", "PV_avg_pct_wert"])

    rows = []

    if quellen:
        target_quellen = [str(q) for q in quellen if str(q).strip()]
    else:
        target_quellen = hist["Quelle"].dropna().astype(str).unique().tolist()

    for quelle in target_quellen:
        offer = hist[hist["Quelle"].eq(quelle)].copy()
        if offer.empty:
            continue

        offer_date = offer["Datum"].dropna().min()

        ref = hist_ref_base[~hist_ref_base["Quelle"].eq(quelle)].copy()

        if pd.notna(offer_date):
            ref = ref[ref["Datum"].lt(offer_date)].copy()

        if ref.empty:
            rows.append({
                "Quelle": quelle,
                "PV_avg_pct_pos": pd.NA,
                "PV_avg_pct_wert": pd.NA,
            })
            continue

        stats = (
            ref.groupby("Artikelnummer", as_index=False)
               .agg(_Median=("Preis", "median"))
        )

        offer = offer.merge(stats, on="Artikelnummer", how="left")
        offer = offer[pd.notna(offer["_Median"]) & (offer["_Median"] > 0)].copy()

        if offer.empty:
            rows.append({
                "Quelle": quelle,
                "PV_avg_pct_pos": pd.NA,
                "PV_avg_pct_wert": pd.NA,
            })
            continue

        offer["_pct"] = ((offer["Preis"] - offer["_Median"]) / offer["_Median"]) * 100.0
        offer["_pct"] = pd.to_numeric(offer["_pct"], errors="coerce")

        if "Menge" in offer.columns:
            offer["_qty"] = pd.to_numeric(offer["Menge"], errors="coerce")
        else:
            offer["_qty"] = pd.NA

        offer["_qty"] = offer["_qty"].fillna(1.0).clip(lower=0)

        offer["_w"] = offer["Preis"] * offer["_qty"]
        offer["_w"] = offer["_w"].where(
            pd.notna(offer["_w"]) & (offer["_w"] > 0),
            offer["_qty"]
        )

        offer = offer[pd.notna(offer["_pct"]) & (offer["_pct"].abs() <= 100.0)].copy()

        if offer.empty:
            rows.append({
                "Quelle": quelle,
                "PV_avg_pct_pos": pd.NA,
                "PV_avg_pct_wert": pd.NA,
            })
            continue

        avg_pos = float(offer["_pct"].mean())

        w_sum = float(offer["_w"].sum())
        if w_sum > 0:
            avg_wert = float((offer["_pct"] * offer["_w"]).sum() / w_sum)
        else:
            avg_wert = avg_pos

        rows.append({
            "Quelle": quelle,
            "PV_avg_pct_pos": avg_pos,
            "PV_avg_pct_wert": avg_wert,
        })

    return pd.DataFrame(rows)


def offer_percent_metrics(
    prices: pd.DataFrame,
    window_days: int = 365,
    sources: Sequence[str] | None = None,
) -> pd.DataFrame:
    """Calculate position- and project-weighted historic deviations."""

    return _build_offer_pv_metrics_for_meta_cache(
        prices,
        window_days=window_days,
        quellen=list(sources) if sources is not None else None,
    )


def freeze_offer_percent_metrics(
    prices: pd.DataFrame,
    frozen_by_source: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    force_recalc: bool = False,
    window_days: int = 365,
    sources: Sequence[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Pure equivalent of legacy ``pv_frozen`` read-or-calculate behavior.

    Existing entries containing ``avg_pct`` remain unchanged unless
    ``force_recalc`` is true.  The caller owns persistence of the returned map.
    """

    existing = {str(k): dict(v) for k, v in (frozen_by_source or {}).items()}
    if prices is None or prices.empty or "Quelle" not in prices.columns:
        return existing
    target = (
        [str(value) for value in sources]
        if sources is not None
        else prices["Quelle"].dropna().astype(str).unique().tolist()
    )
    calculate = [
        source for source in target
        if force_recalc or "avg_pct" not in existing.get(source, {})
    ]
    if not calculate:
        return existing
    metrics = offer_percent_metrics(prices, window_days=window_days, sources=calculate)
    by_source = {
        str(row["Quelle"]): row
        for row in metrics.to_dict(orient="records")
    }
    asof = pd.Timestamp.now(tz=None).normalize().isoformat()
    for source in calculate:
        row = by_source.get(source, {})
        avg_pos = row.get("PV_avg_pct_pos", pd.NA)
        avg_wert = row.get("PV_avg_pct_wert", pd.NA)
        existing[source] = {
            "avg_pct": None if pd.isna(avg_wert) else float(avg_wert),
            "avg_pct_pos": None if pd.isna(avg_pos) else float(avg_pos),
            "avg_pct_wert": None if pd.isna(avg_wert) else float(avg_wert),
            "asof": asof,
            "window_days": int(window_days),
        }
    return existing


# ---------------------------------------------------------------------------
# Offer details and article history
# ---------------------------------------------------------------------------

OFFER_POSITION_COLUMNS = [
    "Artikelnummer",
    "Bezeichnung",
    "Menge",
    "Nettopreis",
    "Preis",
    "Preis_min",
    "Preis_max",
    "Preisvergleich",
]


def price_comparison_emoji(value: Any, median: Any) -> str:
    try:
        value = float(value)
        median = float(median)
    except Exception:
        return "—"
    if pd.isna(value) or pd.isna(median) or median == 0:
        return "—"
    diff = (value - median) / median * 100.0
    if diff >= 25.0:
        return "🔴"
    if diff >= 10.0:
        return "🟠"
    if diff > -10.0:
        return "🟡️"
    if diff > -25.0:
        return "🟢️"
    return "🟢🟢"


def _setting_map(settings: Mapping[str, Any] | None, primary: str, legacy: str) -> Mapping:
    data = settings or {}
    value = data.get(primary, data.get(legacy, {}))
    return value if isinstance(value, Mapping) else {}


def offer_positions(
    source: str,
    df_dn: pd.DataFrame,
    raw_prices: pd.DataFrame,
    settings: Mapping[str, Any] | None,
) -> pd.DataFrame:
    """Build the original offer detail rows and 12-month older-offer stats.

    ``settings`` accepts the native keys ``discounts``, ``align_netto``,
    ``manual_prices`` and ``offer_types``.  The legacy session-state key names
    are accepted as aliases for migration safety.
    """

    discounts = _setting_map(settings, "discounts", "offer_discounts")
    align_netto = _setting_map(settings, "align_netto", "offer_align_netto")
    manual_prices = _setting_map(settings, "manual_prices", "manual_prices")
    offer_types = _setting_map(settings, "offer_types", "offer_types")

    all_prices = prepare_prices(
        raw_prices,
        df_dn,
        discounts,
        align_netto,
        dict(manual_prices),
        offer_types,
    )
    if all_prices.empty or "Quelle" not in all_prices.columns:
        return pd.DataFrame(columns=OFFER_POSITION_COLUMNS)

    source = str(source)
    df_offer = all_prices[all_prices["Quelle"].astype(str).eq(source)].copy()
    if df_offer.empty:
        return pd.DataFrame(columns=OFFER_POSITION_COLUMNS)

    if (
        isinstance(df_dn, pd.DataFrame)
        and not df_dn.empty
        and {"Artikelnummer", "Bezeichnung", "Nettopreis"}.issubset(df_dn.columns)
    ):
        dn_min = df_dn[["Artikelnummer", "Bezeichnung", "Nettopreis"]].copy()
        dn_min["Artikelnummer"] = dn_min["Artikelnummer"].astype(str).map(clean_artnr)
        dn_min = dn_min.dropna(subset=["Artikelnummer"]).drop_duplicates(
            subset=["Artikelnummer"], keep="first"
        )
    else:
        dn_min = pd.DataFrame(columns=["Artikelnummer", "Bezeichnung", "Nettopreis"])

    df_offer["Artikelnummer"] = df_offer["Artikelnummer"].astype(str).map(clean_artnr)
    df_offer.drop(columns=["Bezeichnung", "Nettopreis"], inplace=True, errors="ignore")
    df_offer = df_offer.merge(dn_min, on="Artikelnummer", how="left")

    align_active = bool(align_netto.get(source, False))

    df_offer["Preis"] = pd.to_numeric(df_offer["Preis"], errors="coerce")
    df_offer["Nettopreis"] = pd.to_numeric(df_offer["Nettopreis"], errors="coerce")

    if "Preis_raw" in df_offer.columns:
        df_offer["Preis_pdf"] = pd.to_numeric(df_offer["Preis_raw"], errors="coerce")
    else:
        df_offer["Preis_pdf"] = df_offer["Preis"]

    df_offer["Preis_system"] = df_offer["Preis_pdf"]

    if align_active:
        mask_align = (
            pd.notna(df_offer["Preis_system"])
            & pd.notna(df_offer["Nettopreis"])
            & (df_offer["Nettopreis"] > 0)
            & (df_offer["Nettopreis"] < df_offer["Preis_system"])
        )
        df_offer.loc[mask_align, "Preis_system"] = df_offer.loc[mask_align, "Nettopreis"]

    discount_pct = float(discounts.get(source, 0.0))
    df_offer["Preis_system"] = df_offer["Preis_system"].apply(
        lambda v: float(v) * (1.0 - discount_pct / 100.0) if pd.notna(v) else v
    )

    df_offer["_manual_key"] = df_offer["Artikelnummer"].astype(str).map(clean_artnr).map(
        lambda a: _manual_price_key(source, a)
    )
    df_offer["_manual_preis"] = df_offer["_manual_key"].map(manual_prices)
    df_offer["_manual_preis"] = pd.to_numeric(df_offer["_manual_preis"], errors="coerce")

    df_offer["Preis"] = df_offer["Preis_system"]
    mask_manual = pd.notna(df_offer["_manual_preis"])
    df_offer["Preis_manuell"] = mask_manual
    df_offer.loc[mask_manual, "Preis"] = df_offer.loc[mask_manual, "_manual_preis"]

    if "Bezeichnung (PDF)" in df_offer.columns:
        df_offer["Bezeichnung"] = df_offer["Bezeichnung"].where(
            df_offer["Bezeichnung"].notna()
            & (df_offer["Bezeichnung"].astype(str).str.strip() != ""),
            df_offer["Bezeichnung (PDF)"],
        )

    if "Bezeichnung (PDF)" in df_offer.columns:
        df_offer["Bezeichnung"] = df_offer["Bezeichnung"].where(
            df_offer["Bezeichnung"].notna()
            & (df_offer["Bezeichnung"].astype(str).str.strip() != ""),
            df_offer["Bezeichnung (PDF)"],
        )

    df_offer["Bezeichnung"] = (
        df_offer["Bezeichnung"]
        .astype(str)
        .str.strip()
        .replace({"": pd.NA, "None": pd.NA, "nan": pd.NA})
    )

    df_offer.loc[df_offer["Preis"].eq(0), "Preis"] = pd.NA

    now = pd.Timestamp.now(tz=None).normalize()
    cutoff = now - pd.Timedelta(days=365)
    offer_articles = set(
        df_offer["Artikelnummer"].dropna().astype(str).map(clean_artnr)
    )

    if offer_articles:
        hist_all = all_prices[
            all_prices["Artikelnummer"].astype(str).map(clean_artnr).isin(offer_articles)
        ].copy()
    else:
        hist_all = pd.DataFrame(columns=all_prices.columns)

    if not hist_all.empty:
        hist_all["Artikelnummer"] = hist_all["Artikelnummer"].astype(str).map(clean_artnr)
        hist_all["Datum"] = pd.to_datetime(hist_all["Datum"], errors="coerce")
        hist_all = hist_all[
            hist_all["Datum"].ge(cutoff) & hist_all["Datum"].le(now)
        ].copy()
        hist_all = hist_all[~hist_all["Quelle"].astype(str).eq(source)].copy()

        row_date = pd.to_datetime(df_offer.get("Datum"), errors="coerce").max()
        if pd.notna(row_date):
            hist_all = hist_all[hist_all["Datum"].lt(row_date)].copy()

        hist_all["Preis"] = pd.to_numeric(hist_all["Preis"], errors="coerce")

    stats_range = (
        hist_all.groupby("Artikelnummer", as_index=False)
        .agg(Preis_min=("Preis", "min"), Preis_max=("Preis", "max"))
    )

    hist_cmp = hist_all.copy()
    if "Angebotsart" in hist_cmp.columns:
        hist_cmp["Angebotsart"] = hist_cmp["Angebotsart"].fillna("Erstangebot").astype(str)
        hist_cmp = hist_cmp[hist_cmp["Angebotsart"].eq("Erstangebot")].copy()

    stats_cmp = (
        hist_cmp.groupby("Artikelnummer", as_index=False)
        .agg(_Median=("Preis", "median"))
    )

    stats = stats_range.merge(stats_cmp, on="Artikelnummer", how="outer")

    for column in ["Preis_min", "Preis_max", "_Median", "Preisvergleich"]:
        if column in df_offer.columns:
            df_offer.drop(columns=[column], inplace=True)

    df_offer = df_offer.merge(stats, on="Artikelnummer", how="left")
    df_offer["Preis"] = pd.to_numeric(df_offer["Preis"], errors="coerce")
    df_offer["Preisvergleich"] = df_offer.apply(
        lambda row: price_comparison_emoji(row.get("Preis"), row.get("_Median")),
        axis=1,
    )

    for column in ["Preis_min", "Preis_max"]:
        if column in df_offer.columns:
            df_offer[column] = pd.to_numeric(df_offer[column], errors="coerce").round(2)

    if "PDF_Order" in df_offer.columns:
        df_offer = df_offer.sort_values(["PDF_Order", "Artikelnummer"])

    for column in OFFER_POSITION_COLUMNS:
        if column not in df_offer.columns:
            df_offer[column] = pd.NA

    result = (
        df_offer[
            df_offer["Artikelnummer"].notna()
            & pd.notna(df_offer["Nettopreis"])
        ][OFFER_POSITION_COLUMNS]
        .reset_index(drop=True)
    )
    result["Bezeichnung"] = result["Bezeichnung"].fillna("—")
    return result


def _first_two_datanorm_lines(value: object) -> tuple[str, str]:
    raw = str(value or "").split("\n")
    raw = [line.strip() for line in raw if line and line.strip()]
    skip_prefixes = ("Mat.:", "Einheit:")
    skip_exact = {"für Kabelleiter"}
    lines = [
        line
        for line in raw
        if not any(line.startswith(prefix) for prefix in skip_prefixes)
        and line not in skip_exact
    ]
    first = lines[0] if len(lines) >= 1 else ""
    second = lines[1] if len(lines) >= 2 else ""
    first = re.sub(r"\s+", " ", first).strip()[:120]
    second = re.sub(r"\s+", " ", second).strip()[:120]
    return first, second


def _is_placeholder_dash(value: object) -> bool:
    value_text = "" if value is None else str(value)
    value_text = (
        value_text.replace("\u00A0", " ")
        .replace("\u202F", " ")
        .replace("\u2007", " ")
        .strip()
    )
    if not value_text:
        return False
    value_text = (
        value_text.replace("—", "-")
        .replace("–", "-")
        .replace("−", "-")
        .replace("-", "-")
        .replace("‒", "-")
    )
    return bool(re.fullmatch(r"-+", value_text))


def offer_export_frames(
    source: str,
    df_dn: pd.DataFrame,
    raw_prices: pd.DataFrame,
    settings: Mapping[str, Any] | None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return the exact offer-detail inputs used by Excel and PN export.

    The Excel frame includes ``Kurzbezeichnung`` immediately before
    ``Bezeichnung`` and removes OBO dash-only placeholder positions.  The PN
    frame keeps the original base order and at most the first recognized
    short-name alias.
    """

    positions = offer_positions(source, df_dn, raw_prices, settings)
    excel_frame = positions.copy()

    short_map: dict[str, str] = {}
    if (
        isinstance(df_dn, pd.DataFrame)
        and not df_dn.empty
        and {"Artikelnummer", "Bezeichnung"}.issubset(df_dn.columns)
    ):
        index = df_dn[["Artikelnummer", "Bezeichnung"]].copy()
        index["Artikelnummer"] = index["Artikelnummer"].astype(str).map(clean_artnr)
        split_lines = index["Bezeichnung"].map(_first_two_datanorm_lines)
        index["Bez1"] = split_lines.map(lambda value: value[0])
        index["Badge2"] = split_lines.map(lambda value: value[1])
        index["Badge2_eff"] = index["Badge2"].where(
            index["Badge2"].astype(str).str.len() > 0,
            index["Bez1"],
        )
        short_map = (
            index.dropna(subset=["Artikelnummer"])
            .drop_duplicates(subset=["Artikelnummer"])
            .set_index("Artikelnummer")["Badge2_eff"]
            .to_dict()
        )

    excel_frame["Kurzbezeichnung"] = (
        excel_frame["Artikelnummer"].astype(str).map(clean_artnr).map(short_map)
        if "Artikelnummer" in excel_frame.columns
        else pd.Series(dtype=object)
    )

    excel_columns = list(OFFER_POSITION_COLUMNS)
    if "Bezeichnung" in excel_columns and "Kurzbezeichnung" not in excel_columns:
        excel_columns.insert(excel_columns.index("Bezeichnung"), "Kurzbezeichnung")
    for column in excel_columns:
        if column not in excel_frame.columns:
            excel_frame[column] = pd.NA

    drop_mask = pd.Series(False, index=excel_frame.index)
    for column in ["Kurzbezeichnung", "Bezeichnung", "Artikelnummer"]:
        if column in excel_frame.columns:
            drop_mask |= excel_frame[column].map(_is_placeholder_dash)
    excel_frame = excel_frame.loc[~drop_mask, excel_columns].copy()

    base_columns = ["Artikelnummer", "Bezeichnung", "Menge", "Preis"]
    alias_columns = ["Kurzbezeichnung", "Kürzel", "Artikelkürzel", "Typ"]
    pn_columns = base_columns.copy()
    for column in alias_columns:
        if column in positions.columns:
            pn_columns.append(column)
            break
    for column in pn_columns:
        if column not in positions.columns:
            positions[column] = pd.NA
    pn_frame = positions[pn_columns].copy()
    return excel_frame, pn_frame


def article_history(
    article: object,
    prices: pd.DataFrame,
    selected_offer_types: Sequence[str] | None = None,
) -> pd.DataFrame:
    """Return the legacy newest-first history used by the article view."""

    if prices is None or prices.empty or "Artikelnummer" not in prices.columns:
        return pd.DataFrame()
    art = clean_artnr(article)
    history = prices.copy()
    history["Artikelnummer"] = history["Artikelnummer"].astype(str).map(clean_artnr)
    history = history[history["Artikelnummer"].eq(art)].copy()
    if history.empty:
        return history
    history["Datum"] = pd.to_datetime(history.get("Datum"), errors="coerce")
    history["Monat"] = history["Datum"].dt.strftime("%Y-%m")
    if selected_offer_types is not None and "Angebotsart" in history.columns:
        history = history[
            history["Angebotsart"].astype(str).isin([str(v) for v in selected_offer_types])
        ].copy()
    if "PDF_Order" not in history.columns:
        history["PDF_Order"] = pd.NA
    return history.sort_values(
        ["Datum", "Quelle", "PDF_Order"],
        ascending=[False, True, True],
    ).reset_index(drop=True)


def _article_total_number(value: object) -> float | None:
    if pd.isna(value):
        return None
    raw = str(value).strip().replace("€", "").replace("\xa0", "").replace(" ", "")
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except Exception:
        return None


def _article_total_label(value: object) -> str | None:
    if value is None or pd.isna(value):
        return None
    formatted = f"{float(value):,.2f}"
    formatted = formatted.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{formatted} €"


def article_export_frame(
    article: object,
    prices: pd.DataFrame,
    selected_offer_types: Sequence[str] | None = None,
) -> pd.DataFrame:
    """Build the original article-view table/CSV frame.

    This intentionally retains the source view's merge by ``Quelle`` when
    carrying offer totals into the result.  That detail matters if a source
    contains more than one matching row.
    """

    filtered = article_history(article, prices, selected_offer_types)
    show_columns = [
        "Monat",
        "Preis",
        "Menge",
        "Quelle",
        "Projekt",
        "Gesamtpreis (Angebot)",
        "Angebot",
        "Angebotsart",
    ]
    for column in show_columns:
        if column not in filtered.columns:
            filtered[column] = pd.NA

    chart_data = filtered.dropna(subset=["Preis"]).copy()
    chart_data["Datum"] = pd.to_datetime(chart_data.get("Datum"), errors="coerce")
    chart_data = chart_data.dropna(subset=["Datum"]).copy()
    if "PDF_Order" not in chart_data.columns:
        chart_data["PDF_Order"] = pd.NA
    chart_data = chart_data.sort_values(
        ["Datum", "Quelle", "PDF_Order"],
        ascending=[False, True, True],
    ).reset_index(drop=True)

    total_candidates = [
        "Gesamtbetrag", "Gesamtbetrag (netto)", "Gesamt (netto)", "Gesamt netto",
        "Gesamt zzgl. MwSt", "Angebotssumme", "Angebot_Gesamt",
        "offer_total", "total_sum",
    ]
    total_column = next((column for column in total_candidates if column in chart_data.columns), None)
    if total_column is not None:
        chart_data["__Gesamtpreis"] = chart_data[total_column].map(_article_total_number)
    else:
        chart_data["__Gesamtpreis"] = None
    chart_data["__GesamtpreisLabel"] = chart_data["__Gesamtpreis"].map(_article_total_label)

    if "__GesamtpreisLabel" in chart_data.columns:
        left = filtered.copy()
        left["Quelle"] = left["Quelle"].astype(str)
        right = chart_data[["Quelle", "__Gesamtpreis", "__GesamtpreisLabel"]].copy()
        right["Quelle"] = right["Quelle"].astype(str)
        filtered = left.merge(right, on="Quelle", how="left", copy=False)
        if "__Gesamtpreis" in filtered.columns:
            filtered["Gesamtpreis (Angebot)"] = filtered["__Gesamtpreis"]
        filtered.drop(
            columns=["__Gesamtpreis", "__GesamtpreisLabel"],
            inplace=True,
            errors="ignore",
        )
    elif "Gesamtpreis (Angebot)" not in filtered.columns:
        filtered["Gesamtpreis (Angebot)"] = None

    view = filtered[show_columns].rename(columns={"Preis": "Angebotspreis"}).copy()
    view["Angebotspreis"] = pd.to_numeric(view["Angebotspreis"], errors="coerce").round(2)
    view["Menge"] = pd.to_numeric(view["Menge"], errors="coerce")
    view["Gesamtpreis (Angebot)"] = pd.to_numeric(
        view["Gesamtpreis (Angebot)"], errors="coerce"
    )
    return view


def article_statistics(
    article: object,
    df_dn: pd.DataFrame,
    prices: pd.DataFrame,
    selected_offer_types: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Return the article view's filtered 24-month median and Datanorm delta."""

    history = article_history(article, prices, selected_offer_types)
    chart_data = history.dropna(subset=["Preis"]).copy() if "Preis" in history.columns else pd.DataFrame()
    if not chart_data.empty:
        chart_data["Datum"] = pd.to_datetime(chart_data["Datum"], errors="coerce")
        chart_data = chart_data.dropna(subset=["Datum"])

    median_24m_val = None
    if not chart_data.empty:
        cutoff_24m = pd.Timestamp.today().normalize() - pd.DateOffset(months=24)
        values = pd.to_numeric(
            chart_data.loc[chart_data["Datum"] >= cutoff_24m, "Preis"],
            errors="coerce",
        ).dropna()
        if not values.empty:
            median_24m_val = float(values.median())

    dn_val = None
    art = clean_artnr(article)
    if (
        isinstance(df_dn, pd.DataFrame)
        and not df_dn.empty
        and {"Artikelnummer", "Nettopreis"}.issubset(df_dn.columns)
    ):
        match = df_dn[df_dn["Artikelnummer"].astype(str).map(clean_artnr).eq(art)]
        if not match.empty and pd.notna(match.iloc[0].get("Nettopreis")):
            try:
                raw = str(match.iloc[0].get("Nettopreis")).strip().replace("€", "")
                raw = raw.replace("\xa0", "").replace(" ", "")
                if "," in raw:
                    raw = raw.replace(".", "").replace(",", ".")
                dn_val = float(raw)
            except Exception:
                dn_val = None

    median_delta_pct = 0.0
    if median_24m_val is not None and dn_val is not None and float(dn_val) != 0.0:
        try:
            median_delta_pct = ((float(median_24m_val) - float(dn_val)) / float(dn_val)) * 100.0
        except Exception:
            median_delta_pct = 0.0

    return {
        "article": art,
        "offer_count": int(len(history)),
        "offer_count_24m": int(len(chart_data[chart_data["Datum"] >= (pd.Timestamp.today().normalize() - pd.DateOffset(months=24))])) if not chart_data.empty else 0,
        "median_24m": median_24m_val,
        "datanorm_price": dn_val,
        "median_delta_pct": median_delta_pct,
    }


__all__ = [
    "DATANORM_ARTICLE_CLUSTERS",
    "DATANORM_CLUSTER_ALL_OPTION",
    "DATANORM_CLUSTER_VERSION",
    "DEFAULT_NET_PRICE_REFERENCE_ARTICLES",
    "OFFER_POSITION_COLUMNS",
    "SOURCE_FUNCTION_SHA256",
    "SOURCE_PROVENANCE",
    "apply_manual_prices",
    "article_history",
    "article_export_frame",
    "article_statistics",
    "build_offers_meta",
    "clean_artnr",
    "coerce_reference_weight",
    "datanorm_comparison",
    "default_reference_rows",
    "extract_prices_from_pdf",
    "freeze_offer_percent_metrics",
    "manual_price_key",
    "manual_prices_for_source",
    "normalize_reference_rows",
    "offer_percent_metrics",
    "offer_export_frames",
    "offer_positions",
    "parse_datanorm_bytes",
    "parse_datanorm_v4_text",
    "parse_reference_articles_text",
    "prepare_prices",
    "price_comparison_emoji",
    "smart_float",
    "suggestions",
]
