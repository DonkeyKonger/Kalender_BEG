from __future__ import annotations

import ast
import hashlib
import io
import os
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pandas.testing as pdt
import pytest
from reportlab.pdfgen import canvas

from app.services import price_comparison_core as core


FROZEN_REFERENCE = (
    Path(__file__).parent
    / "fixtures"
    / "priceviewer_reference"
    / "viewer_core_reference.py"
)
LEGACY_VIEWER = Path(os.environ.get("PRICEVIEWER_CORE_REFERENCE", FROZEN_REFERENCE))


def make_synthetic_offer_pdf() -> bytes:
    """Create a non-sensitive PDF parsed by the original text fallback."""

    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    lines = [
        "01.05.2026",
        "Angebot: TEST-1",
        "Projektname: Testprojekt Angebot: TEST-1",
        "OBO Bettermann",
        "6047611 RKSM 620 FS 100,00 Meter 12,34 1",
        "Gesamt netto 1.234,00 EUR",
    ]
    y = 800
    for line in lines:
        pdf.drawString(72, y, line)
        y -= 24
    pdf.save()
    return output.getvalue()


def _datanorm_bytes() -> bytes:
    text = "\n".join(
        [
            "A;I;0006047611;;RKS-Magic Kabelrinne;;2;2;m;12345;0410",
            "B;;;RKSM 620 FS",
            "T;;;;Mat.: Stahl;für Kabeltrassen",
            "C",
            "A;I;6036560;;Brüstungskanal;;2;0;m;2500;0610",
            "B;;;Rapid 80 G",
            "C",
        ]
    )
    return text.encode("cp1252")


def _legacy_function_namespace(*names: str, session_state: dict | None = None) -> dict:
    assert LEGACY_VIEWER.is_file(), f"missing frozen reference: {LEGACY_VIEWER}"
    source = LEGACY_VIEWER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    wanted = set(names)
    nodes = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    ]
    assert {node.name for node in nodes} == wanted
    namespace = dict(vars(core))
    namespace["st"] = SimpleNamespace(session_state=session_state or {})
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), "viewer.py", "exec"), namespace)
    return namespace


def _raw_prices() -> pd.DataFrame:
    now = pd.Timestamp.now(tz=None).normalize()
    return pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Preis": 30.0,
                "Quelle": "current.pdf",
                "PDF_Order": 1,
                "Bezeichnung (PDF)": "PDF Kabelrinne",
                "Menge": 2.0,
                "Datum": now - pd.Timedelta(days=10),
                "Projekt": "Aktuell",
                "Angebot": "CUR",
                "Anbieter": "OBO",
                "Gesamt (netto)": "1.234,50",
            },
            {
                "Artikelnummer": "6047611",
                "Preis": 10.0,
                "Quelle": "old-a.pdf",
                "PDF_Order": 1,
                "Menge": 1.0,
                "Datum": now - pd.Timedelta(days=100),
                "Projekt": "Alt A",
                "Angebot": "A",
                "Anbieter": "OBO",
                "Gesamt (netto)": 100.0,
            },
            {
                "Artikelnummer": "6047611",
                "Preis": 12.0,
                "Quelle": "old-b.pdf",
                "PDF_Order": 1,
                "Menge": 3.0,
                "Datum": now - pd.Timedelta(days=80),
                "Projekt": "Alt B",
                "Angebot": "B",
                "Anbieter": "OBO",
                "Gesamt (netto)": 200.0,
            },
            {
                "Artikelnummer": "6047611",
                "Preis": 100.0,
                "Quelle": "old-follow.pdf",
                "PDF_Order": 1,
                "Menge": 1.0,
                "Datum": now - pd.Timedelta(days=70),
                "Projekt": "Alt Folge",
                "Angebot": "F",
                "Anbieter": "OBO",
                "Gesamt (netto)": 300.0,
            },
        ]
    )


def _datanorm_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Bezeichnung": "Kabelrinne\nRKSM 620 FS\nMat.: Stahl",
                "Kurzbezeichnung": "RKSM 620 FS",
                "Nettopreis": 20.0,
                "Einheit": "m",
                "Artikelcluster": core.DATANORM_CLUSTER_FS,
                "Cluster-Sicherheit": "sicher",
            }
        ]
    )


def test_pdf_parser_matches_audited_revision_and_parses_synthetic_pdf() -> None:
    parser_path = Path(core.__file__).with_name("price_comparison_pdf_parser.py")
    digest = hashlib.sha256(parser_path.read_bytes()).hexdigest()
    assert digest == core.SOURCE_PROVENANCE["pdf_parser_sha256"]

    parsed = core.extract_prices_from_pdf(
        make_synthetic_offer_pdf(),
        source_name="synthetic.pdf",
    )
    assert len(parsed) == 1
    row = parsed.iloc[0]
    assert row["Artikelnummer"] == "6047611"
    assert row["Preis"] == pytest.approx(12.34)
    assert row["Menge"] == pytest.approx(100.0)
    assert row["Quelle"] == "synthetic.pdf"
    assert row["Angebot"] == "TEST-1"
    assert row["Projekt"] == "Testprojekt"
    assert row["Gesamt (netto)"] == pytest.approx(1234.0)


def test_source_hash_manifest_matches_verified_viewer_snapshot() -> None:
    assert LEGACY_VIEWER.is_file(), f"missing frozen reference: {LEGACY_VIEWER}"
    source = LEGACY_VIEWER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    found = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in core.SOURCE_FUNCTION_SHA256:
            segment = ast.get_source_segment(source, node)
            found[node.name] = hashlib.sha256(segment.encode()).hexdigest()
    assert found == core.SOURCE_FUNCTION_SHA256


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("00-abc.123", "ABC123"),
        (None, "NONE"),
        ("000", ""),
    ],
)
def test_clean_artnr_matches_extracted_legacy(value: object, expected: str) -> None:
    legacy = _legacy_function_namespace("clean_artnr")["clean_artnr"]
    assert core.clean_artnr(value) == legacy(value) == expected


@pytest.mark.parametrize(
    "value",
    ["1.234,56 EUR", "12,3", "EUR 1,234.50", "-", None, "42"],
)
def test_smart_float_matches_extracted_legacy(value: object) -> None:
    legacy = _legacy_function_namespace("smart_float")["smart_float"]
    assert core.smart_float(value) == legacy(value)


def test_datanorm_parser_matches_extracted_legacy_and_classifies() -> None:
    legacy_ns = _legacy_function_namespace(
        "clean_artnr",
        "_to_decimal_eur",
        "_preiseinheit_multiplier",
        "_datanorm_cluster_search_text",
        "_detect_datanorm_material",
        "_classify_datanorm_article_cluster",
        "parse_datanorm_v4_text",
        "_parse_datanorm_bytes",
    )
    expected = legacy_ns["_parse_datanorm_bytes"](_datanorm_bytes())
    actual = core.parse_datanorm_bytes(_datanorm_bytes())
    pdt.assert_frame_equal(actual.reset_index(drop=True), expected.reset_index(drop=True))
    first = actual.loc[actual["Artikelnummer"].eq("6047611")].iloc[0]
    assert first["Nettopreis"] == pytest.approx(1.2345)
    assert first["Artikelcluster"] == core.DATANORM_CLUSTER_FS
    second = actual.loc[actual["Artikelnummer"].eq("6036560")].iloc[0]
    assert second["Artikelcluster"] == core.DATANORM_CLUSTER_CHANNELS


def test_reference_normalization_matches_legacy() -> None:
    legacy_ns = _legacy_function_namespace(
        "clean_artnr",
        "_coerce_reference_weight",
        "_normalize_reference_rows",
    )
    rows = [
        {"Artikelnummer": "006047611", "Gewichtung": "0,75x"},
        {"article": "6047611", "weight": 2},
        {"art": "6036560", "weight": 0},
        "6036564",
        {"Artikelnummer": "bad", "Gewichtung": 1},
    ]
    expected = legacy_ns["_normalize_reference_rows"](rows)
    assert core.normalize_reference_rows(rows) == expected == [
        {"Artikelnummer": "6047611", "Gewichtung": 0.75},
        {"Artikelnummer": "6036564", "Gewichtung": 1.0},
    ]


def test_prepare_prices_keeps_legacy_order_and_manual_override() -> None:
    raw = pd.DataFrame(
        [{"Artikelnummer": "006047611", "Quelle": "offer.pdf", "Preis": 100.0}]
    )
    dn = pd.DataFrame([{"Artikelnummer": "6047611", "Nettopreis": 80.0}])
    result = core.prepare_prices(
        raw,
        dn,
        {"offer.pdf": 10.0},
        {"offer.pdf": True},
        {"offer.pdf||6047611": 65.0},
        {"offer.pdf": "Verhandeltes Angebot"},
    )
    row = result.iloc[0]
    assert row["Preis_raw"] == pytest.approx(100.0)
    assert row["Preis_basis"] == pytest.approx(80.0)
    assert row["Rabatt_%"] == pytest.approx(10.0)
    assert row["Preis"] == pytest.approx(65.0)
    assert bool(row["Preis_manuell"])
    assert bool(row["Rabattiert"])
    assert row["Angebotsart"] == "Verhandeltes Angebot"

    legacy_ns = _legacy_function_namespace(
        "clean_artnr",
        "_apply_manual_prices_to_df",
        "_prepare_all_prices_for_current_runtime_settings",
        session_state={
            "offer_align_netto": {"offer.pdf": True},
            "offer_discounts": {"offer.pdf": 10.0},
            "manual_prices": {"offer.pdf||6047611": 65.0},
        },
    )
    legacy_input = raw.assign(Preis_raw=raw["Preis"])
    expected = legacy_ns["_prepare_all_prices_for_current_runtime_settings"](legacy_input, dn)
    comparable = result.drop(columns=["Angebotsart", "Rabattiert"])
    pdt.assert_frame_equal(comparable, expected)


def test_datanorm_comparison_matches_legacy_session_state_version() -> None:
    now = pd.Timestamp.now(tz=None).normalize()
    dn = _datanorm_frame()
    prices = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Quelle": f"offer-{index}.pdf",
                "Preis": float(30 + index),
                "Preis_raw": float(30 + index),
                "Datum": now - pd.Timedelta(days=index),
            }
            for index in range(6)
        ]
    )
    discounts = {"offer-0.pdf": 10.0}
    align = {"offer-1.pdf": True}
    actual = core.datanorm_comparison(dn, prices, discounts, align)
    legacy_ns = _legacy_function_namespace(
        "clean_artnr",
        "_build_tab1_datanorm_offer_df",
        session_state={"offer_discounts": discounts, "offer_align_netto": align},
    )
    expected = legacy_ns["_build_tab1_datanorm_offer_df"](dn, prices)
    pdt.assert_frame_equal(actual, expected)
    assert actual.iloc[0]["Angebotspreis 1"] == pytest.approx(27.0)
    assert actual.iloc[0]["Angebotspreis 2"] == pytest.approx(20.0)


def test_weighted_suggestions_match_extracted_legacy() -> None:
    now = pd.Timestamp.now(tz=None).normalize()
    dn = pd.DataFrame(
        [
            {"Artikelnummer": "6047611", "Bezeichnung": "Ref", "Nettopreis": 10.0},
            {"Artikelnummer": "6036560", "Bezeichnung": "Target", "Nettopreis": 35.0},
        ]
    )
    prices = pd.DataFrame(
        [
            {
                "Artikelnummer": article,
                "Preis": price,
                "Preis_raw": price,
                "Datum": now - pd.Timedelta(days=offset),
                "Angebotsart": "Erstangebot",
            }
            for article, price in [("6047611", 20.0), ("6036560", 60.0)]
            for offset in range(5)
        ]
    )
    refs = [{"Artikelnummer": "6047611", "Gewichtung": "2,5"}]
    actual_df, actual_meta = core.suggestions(dn, prices, refs)
    legacy_ns = _legacy_function_namespace("_build_tab1_net_price_suggestions_df")
    expected_df, expected_meta = legacy_ns["_build_tab1_net_price_suggestions_df"](
        dn, prices, refs
    )
    pdt.assert_frame_equal(actual_df, expected_df)
    assert actual_meta == expected_meta
    assert actual_meta["reference_ratio"] == pytest.approx(2.0)
    target = actual_df[actual_df["Artikelnummer"].eq("6036560")].iloc[0]
    assert target["Vorschlag Nettopreis"] == pytest.approx(30.0)
    assert target["Preisvergleich"] == "🔴 Nettopreis schlecht"


def test_offer_positions_use_only_older_other_offers_and_first_offer_median() -> None:
    raw = _raw_prices()
    settings = {
        "discounts": {},
        "align_netto": {},
        "manual_prices": {},
        "offer_types": {"old-follow.pdf": "Folgeangebot"},
    }
    result = core.offer_positions("current.pdf", _datanorm_frame(), raw, settings)
    assert list(result.columns) == core.OFFER_POSITION_COLUMNS
    row = result.iloc[0]
    assert row["Preis"] == pytest.approx(30.0)
    assert row["Preis_min"] == pytest.approx(10.0)
    assert row["Preis_max"] == pytest.approx(100.0)
    # Median is 11.0 from old-a and old-b; Folgeangebot 100 stays out.
    assert row["Preisvergleich"] == "🔴"


def test_offer_export_frames_match_original_column_and_placeholder_rules() -> None:
    excel, pn = core.offer_export_frames(
        "current.pdf",
        _datanorm_frame(),
        _raw_prices(),
        {"offer_types": {"old-follow.pdf": "Folgeangebot"}},
    )
    assert excel.columns.tolist() == [
        "Artikelnummer",
        "Kurzbezeichnung",
        "Bezeichnung",
        "Menge",
        "Nettopreis",
        "Preis",
        "Preis_min",
        "Preis_max",
        "Preisvergleich",
    ]
    assert excel.iloc[0]["Kurzbezeichnung"] == "RKSM 620 FS"
    assert pn.columns.tolist() == ["Artikelnummer", "Bezeichnung", "Menge", "Preis"]


def test_percent_metrics_match_extracted_legacy_and_freeze_is_stationary() -> None:
    prepared = core.prepare_prices(
        _raw_prices(),
        _datanorm_frame(),
        {},
        {},
        {},
        {"old-follow.pdf": "Folgeangebot"},
    )
    # 30 vs. historic median 11 is >100% and therefore excluded by the
    # original hard outlier rule.  Lower it for the arithmetic parity check.
    prepared.loc[prepared["Quelle"].eq("current.pdf"), "Preis"] = 20.0
    actual = core.offer_percent_metrics(prepared, sources=["current.pdf"])
    legacy_ns = _legacy_function_namespace(
        "clean_artnr", "_build_offer_pv_metrics_for_meta_cache"
    )
    expected = legacy_ns["_build_offer_pv_metrics_for_meta_cache"](
        prepared, quellen=["current.pdf"]
    )
    pdt.assert_frame_equal(actual, expected)
    row = actual.iloc[0]
    assert row["PV_avg_pct_pos"] == pytest.approx((20.0 - 11.0) / 11.0 * 100.0)
    assert row["PV_avg_pct_wert"] == pytest.approx(row["PV_avg_pct_pos"])

    existing = {"current.pdf": {"avg_pct": 7.5, "asof": "kept"}}
    frozen = core.freeze_offer_percent_metrics(prepared, existing)
    assert frozen["current.pdf"] == existing["current.pdf"]


def test_article_history_statistics_and_export_frame() -> None:
    prepared = core.prepare_prices(
        _raw_prices(),
        _datanorm_frame(),
        {},
        {},
        {},
        {"old-follow.pdf": "Folgeangebot"},
    )
    history = core.article_history("006047611", prepared, ["Erstangebot"])
    assert len(history) == 3
    assert history.iloc[0]["Quelle"] == "current.pdf"
    assert history.iloc[0]["Monat"] == pd.Timestamp.now().strftime("%Y-%m")

    stats = core.article_statistics(
        "6047611", _datanorm_frame(), prepared, ["Erstangebot"]
    )
    assert stats["median_24m"] == pytest.approx(12.0)
    assert stats["datanorm_price"] == pytest.approx(20.0)
    assert stats["median_delta_pct"] == pytest.approx(-40.0)

    exported = core.article_export_frame("6047611", prepared, ["Erstangebot"])
    assert exported.columns.tolist() == [
        "Monat",
        "Angebotspreis",
        "Menge",
        "Quelle",
        "Projekt",
        "Gesamtpreis (Angebot)",
        "Angebot",
        "Angebotsart",
    ]
    current = exported[exported["Quelle"].eq("current.pdf")].iloc[0]
    assert current["Angebotspreis"] == pytest.approx(30.0)
    assert current["Gesamtpreis (Angebot)"] == pytest.approx(1234.5)


def test_offer_meta_preserves_project_cleanup_and_upload_order() -> None:
    raw = _raw_prices()
    saved = [
        {"name": "old-a.pdf", "mtime": 100.0},
        {"name": "current.pdf", "mtime": 200.0},
        {"name": "old-b.pdf", "mtime": 50.0},
        {"name": "old-follow.pdf", "mtime": 25.0},
    ]
    actual = core.build_offers_meta(
        raw,
        saved,
        {"current.pdf": "Verhandeltes Angebot"},
    )
    assert actual.iloc[0]["Quelle"] == "current.pdf"
    assert actual.iloc[0]["Angebotsart"] == "Verhandeltes Angebot"
    assert actual.iloc[0]["Pos_Anzahl"] == 1
    assert actual.iloc[0]["Upload_ts"] == pytest.approx(200.0)
