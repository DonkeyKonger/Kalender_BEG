from dataclasses import FrozenInstanceError

import pandas as pd
import pytest

from app.services.price_comparison_search import (
    build_article_search_index, search_article_index, unicode_casefold_items,
)
from app.services.price_comparison_service import filter_frame, records
from app.tests.test_price_comparison_routes import context as route_context, seed, upload

context = route_context


@pytest.mark.parametrize("query", ["", "  ", "100", "KABEL", "straße", "STRASSE", "ς", "σ",
                                    "ä", "ﬀ", "ff", ".*", "12.5", "None", "nan", "cluster-a", "m", "missing", "a\x00b"])
@pytest.mark.parametrize("limit", [1, 50, 500])
def test_index_preserves_literal_all_column_search_order_and_values(query, limit):
    frame = pd.DataFrame({
        "Artikelnummer": ["100", "101", "102", "103"],
        "Bezeichnung": ["Kabel Straße ﬀ Ä", "KABEL σς", "a.*b", None],
        "Nettopreis": [12.5, 2.0, float("nan"), 0.0],
        "Artikelcluster": ["cluster-a", None, "cluster-b", "other"],
        "Einheit": ["m", "Stk", "a", "b"],
    }, index=[7, 7, 3, 1])
    old = [{"article_number": str(row["Artikelnummer"]),
            "description": str(row.get("Bezeichnung", "")), "net_price": row.get("Nettopreis")}
           for row in records(filter_frame(frame, query).head(limit))]
    assert search_article_index(build_article_search_index(frame), query, limit) == old


def test_index_is_immutable_and_result_mutation_does_not_leak():
    index = build_article_search_index(pd.DataFrame([{"Artikelnummer": "1", "Bezeichnung": "Test"}]))
    result = search_article_index(index, "test", 50)
    result[0]["description"] = "changed"
    assert search_article_index(index, "test", 50)[0]["description"] == "Test"
    with pytest.raises(FrozenInstanceError):
        index[0].description = "changed"
    assert build_article_search_index(pd.DataFrame()) == ()


def test_browser_normalization_table_matches_server_unicode_casefold():
    table = dict(unicode_casefold_items())
    for text in ["Straße", "ẞΣς ﬀ İ Ä", "ABC e\u0301", "👷", "\U00010400"]:
        assert "".join(table.get(char, char) for char in text) == text.casefold()


def test_article_search_never_loads_or_parses_offers(context, monkeypatch):
    client, service, _ = context
    seed(client)
    original = service.parsed
    def parsed(item, **kwargs):
        assert item.kind == "datanorm"
        return original(item, **kwargs)
    monkeypatch.setattr(service, "parsed", parsed)
    monkeypatch.setattr(service, "load", lambda *a, **kw: pytest.fail("full price load in article search"))
    result = client.get("/api/price-comparison/articles", params={"search": "rksm"})
    assert result.status_code == 200
    assert result.json()["articles"][0]["article_number"] == "6047611"


def test_browser_index_is_private_compressed_and_revision_conditional(context):
    client, _, _ = context
    seed(client)
    response = client.get("/api/price-comparison/article-search-index")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-encoding"] == "gzip"
    result = response.json()
    assert result["rows"][0][:2] == ["6047611", "Kabelrinne\nRKSM 620 FS"]
    assert result["casefold"]["ß"] == "ss"
    same = client.get("/api/price-comparison/article-search-index", params={"known_revision": result["revision"]})
    assert same.json() == {"revision": result["revision"], "unchanged": True}
    assert len(same.content) < 150
    plain = client.get("/api/price-comparison/article-search-index", headers={"Accept-Encoding": "gzip;q=0, *;q=1"})
    assert "content-encoding" not in plain.headers
    assert plain.json() == result


def test_datanorm_upload_immediately_replaces_search_index(context):
    client, _, _ = context
    seed(client)
    before = client.get("/api/price-comparison/article-search-index").json()
    new = b"A;N;9999999;;Neu;;2;0;M;1500;0410\nB;N;9999999;Artikel\nC;\n"
    assert upload(client, "neu.dat", new, "datanorm").status_code == 200
    after = client.get("/api/price-comparison/article-search-index", params={"known_revision": before["revision"]}).json()
    assert after["revision"] != before["revision"]
    assert after["rows"][0][0] == "9999999"


def test_mutations_invalidate_read_snapshots_before_and_after_even_on_failure(context, monkeypatch):
    client, service, _ = context
    from app.services import price_comparison_service as module
    calls = []
    monkeypatch.setattr(module, "invalidate_read_snapshots", lambda *a: calls.append("invalidate"))
    revision = service.status()["revision"]
    service.mutate(revision, lambda snap: calls.append("write"))
    assert calls == ["invalidate", "write", "invalidate"]
    calls.clear()
    with pytest.raises(RuntimeError):
        service.mutate(service.status()["revision"], lambda snap: (_ for _ in ()).throw(RuntimeError("failed")))
    assert calls == ["invalidate", "invalidate"]


def test_offer_only_changes_keep_browser_index_revision_and_skip_rebuild(context, monkeypatch):
    from app.services import price_comparison_service as module
    from app.services.price_comparison_storage import save_state, snapshot
    from app.tests.test_price_comparison_routes import offer_pdf

    client, service, _ = context
    seed(client)
    initial = service.article_search_index()
    def unexpected(*args, **kwargs):
        pytest.fail("offer-only change rebuilt article index")
    monkeypatch.setattr(module, "build_article_search_index", unexpected)
    service.store.write("offers", "Additional.pdf", offer_pdf(number="ADDED"), None)
    current = snapshot(service.store)
    current.state["offer_types"]["Angebot.pdf"] = "Folgeangebot"
    current.state["discounts"]["Angebot.pdf"] = 7
    current.state["manual_prices"]["Angebot.pdf||6047611"] = 8.5
    save_state(service.store, current)
    assert service.article_search_index(initial["revision"]) == {
        "revision": initial["revision"], "unchanged": True,
    }
    assert service.article_search_index()["rows"] == initial["rows"]
