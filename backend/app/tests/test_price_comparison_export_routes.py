from types import SimpleNamespace

import pandas as pd

from app.api.routes import price_comparison as routes


class _Snapshot:
    state = {"discounts": {}, "align_netto": {}}

    def find(self, _kind: str, _name: str):
        return object()


class _Service:
    def __init__(self, data, offers=None):
        self.data = data
        self._offers = offers or []

    def load(self):
        return self.data

    def offers_list(self, _data):
        return self._offers


def _data(**overrides):
    values = {
        "datanorm": pd.DataFrame(),
        "prices": pd.DataFrame(),
        "raw_prices": pd.DataFrame(),
        "offer_sources": [],
        "snap": _Snapshot(),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_suggestions_export_preserves_original_metadata_and_native_article_link(monkeypatch):
    suggestion = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Bezeichnung": "Kabelrinne",
                "Artikelcluster": "Kabelrinnen",
                "Cluster-Sicherheit": "hoch",
                "Medianangebotspreis": 12.0,
                "Preisvergleich": "🟢 Nettopreis gut",
                "Aktueller Nettopreis": 10.0,
                "Vorschlag Nettopreis": 10.5,
            }
        ]
    )
    meta = {
        "reference_articles_valid": ["6047611", "6047638"],
        "reference_weight_total": 1.75,
        "reference_deviation_pct": 19.25,
    }
    captured = {}

    monkeypatch.setattr(routes.core, "suggestions", lambda *_args: (suggestion, meta))

    def export_excel(frame, sheet_name, title=None, subtitle=None):
        captured.update(
            frame=frame,
            sheet_name=sheet_name,
            title=title,
            subtitle=subtitle,
        )
        return b"xlsx", ".xlsx", "application/x-test"

    monkeypatch.setattr(routes.exports, "dataframe_to_excel_download", export_excel)
    payload = routes.ExportRequest(
        kind="suggestions",
        references=[{"article_number": "6047611", "weight": 1.0}],
    )

    response = routes.export(payload, _Service(_data()))

    assert response.body == b"xlsx"
    assert "datanorm_nettopreis_vorschlaege.xlsx" in response.headers[
        "content-disposition"
    ]
    assert captured["sheet_name"] == "Nettopreisvorschlag"
    assert captured["title"] == "Nettopreisrechner"
    assert captured["subtitle"] == (
        "Referenzbasis: 2 verwertbare Referenzartikel, Gewichtung gesamt: 1.75, "
        "durchschnittliche Abweichung Median zu Nettopreis: 19.2%."
    )
    assert list(captured["frame"].columns)[0] == "Artikelvergleich"
    assert captured["frame"].iloc[0]["Artikelvergleich"] == (
        "?view=articles&article=6047611"
    )


def test_offer_excel_uses_original_full_heading_context(monkeypatch):
    source = "Original.pdf"
    offer = {
        "source": source,
        "project": "Projekt 🏗️",
        "offer_number": "A-1",
        "date": "2026-05-01",
        "position_count": 3,
        "offer_type": "Verhandeltes Angebot",
        "discount": 5.0,
        "total_net": 1234.5,
        "price_change_positions": 4.5,
        "price_change": 6.25,
    }
    raw_prices = pd.DataFrame(
        [{"Quelle": source, "Gesamt (brutto)": 1469.06}]
    )
    captured = {}

    monkeypatch.setattr(
        routes.core,
        "offer_export_frames",
        lambda *_args: (pd.DataFrame([{"Artikelnummer": "1"}]), pd.DataFrame()),
    )

    def export_excel(frame, sheet_name, title=None, subtitle=None):
        captured.update(
            frame=frame,
            sheet_name=sheet_name,
            title=title,
            subtitle=subtitle,
        )
        return b"xlsx", ".xlsx", "application/x-test"

    monkeypatch.setattr(routes.exports, "dataframe_to_excel_download", export_excel)
    service = _Service(
        _data(
            raw_prices=raw_prices,
            offer_sources=[SimpleNamespace(name=source)],
        ),
        [offer],
    )

    response = routes.export(
        routes.ExportRequest(kind="offer", source=source),
        service,
    )

    assert response.body == b"xlsx"
    assert "angebot_Original.xlsx" in response.headers["content-disposition"]
    assert captured["sheet_name"] == "Angebot"
    assert captured["title"] == "Projekt | A-1"
    assert captured["subtitle"] == (
        "01.05.2026 | Projekt | # A-1 | 3 Pos. | Verhandelt | "
        "Ø Abw: Pos +4,5% | Projekt +6,2% | Gesamt 1.234,50 € | Rabatt 5,0%"
    )


def test_article_exports_keep_original_filename_and_pdf_chart_months(monkeypatch):
    history = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Preis": 12.5,
                "Datum": pd.Timestamp("2026-05-01"),
                "Quelle": "Angebot.pdf",
                "PDF_Order": 1,
            }
        ]
    )
    article_frame = pd.DataFrame(
        [{"Monat": "2026-05", "Angebotspreis": 12.5, "Angebot": "A-1"}]
    )
    datanorm = pd.DataFrame(
        [
            {
                "Artikelnummer": "6047611",
                "Bezeichnung": "Zeile eins\nZeile zwei\nZeile drei\nMat.: Stahl",
                "Einheit": "MTR",
                "Nettopreis": 10.0,
            }
        ]
    )
    captured = {}

    monkeypatch.setattr(routes.core, "article_history", lambda *_args: history)
    monkeypatch.setattr(routes.core, "article_export_frame", lambda *_args: article_frame)
    monkeypatch.setattr(
        routes.exports,
        "article_offers_to_csv_bytes",
        lambda frame: frame.to_csv(index=False).encode(),
    )
    service = _Service(_data(datanorm=datanorm))

    csv_response = routes.export(
        routes.ExportRequest(kind="article", article_number="006047611"),
        service,
    )
    assert "artikel_6047611_angebote.csv" in csv_response.headers[
        "content-disposition"
    ]

    def build_pdf(art, description, unit, view, chart_data, net_price):
        captured.update(
            art=art,
            description=description,
            unit=unit,
            view=view,
            chart_data=chart_data,
            net_price=net_price,
        )
        return b"pdf"

    monkeypatch.setattr(routes.exports, "build_article_pdf_bytes", build_pdf)
    pdf_response = routes.export(
        routes.ExportRequest(kind="article_pdf", article_number="006047611"),
        service,
    )

    assert pdf_response.body == b"pdf"
    assert "preisvergleich_6047611.pdf" in pdf_response.headers["content-disposition"]
    assert captured["description"] == ["Zeile eins", "Zeile zwei"]
    assert captured["unit"] == "MTR"
    assert captured["net_price"] == 10.0
    assert captured["chart_data"]["DatumLabel"].tolist() == ["05-26"]
    assert captured["chart_data"]["YMin"].tolist() == [6.25]
