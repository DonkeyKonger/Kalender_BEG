from __future__ import annotations

from datetime import date, datetime, timezone

import pandas as pd
import pytest

from app.services.price_comparison_metrics import METRICS_VERSION, offer_price_metrics


AS_OF = date(2026, 11, 26)


def dn(*articles: str, unit: str = "MTR") -> pd.DataFrame:
    return pd.DataFrame({"Artikelnummer": articles, "Einheit": [unit] * len(articles)})


def row(
    source: str,
    article: str,
    price: float | None,
    quantity: float | None,
    when,
    offer: str,
    *,
    offer_type: str = "Erstangebot",
    unit: str | None = "Meter",
    total: float | None = 1_000_000.0,
    raw_price: float | None = None,
    validated: bool | None = None,
    manual: bool | None = None,
    price_unit: float | None = None,
) -> dict:
    result = {
        "Quelle": source,
        "Artikelnummer": article,
        "Preis": price,
        "Menge": quantity,
        "Datum": when,
        "Angebot": offer,
        "Angebotsart": offer_type,
        "Einheit (PDF)": unit,
        "Gesamt (netto)": total,
    }
    if raw_price is not None:
        result["Preis_raw"] = raw_price
    if validated is not None:
        result["Preis_validiert"] = validated
    if manual is not None:
        result["Preis_manuell"] = manual
    if price_unit is not None:
        result["Preiseinheit (PDF)"] = price_unit
    return result


def refs(
    article: str,
    values: tuple[float, ...],
    *,
    dates: tuple[str, ...] | None = None,
    offers: tuple[str, ...] | None = None,
    sources: tuple[str, ...] | None = None,
    unit: str | None = "Meter",
) -> list[dict]:
    dates = dates or tuple(f"2025-0{i + 1}-10" for i in range(len(values)))
    offers = offers or tuple(f"REF-{i + 1}" for i in range(len(values)))
    sources = sources or tuple(f"ref-{i + 1}.pdf" for i in range(len(values)))
    return [
        row(source, article, value, 1, when, offer, unit=unit)
        for source, value, when, offer in zip(sources, values, dates, offers, strict=True)
    ]


def metric(rows: list[dict], datanorm: pd.DataFrame, source: str = "target.pdf", *, as_of=AS_OF):
    return offer_price_metrics(pd.DataFrame(rows), datanorm, as_of=as_of, sources=[source])[source]


def test_matched_basket_uses_target_quantities_and_simple_position_mean() -> None:
    rows = [
        row("target.pdf", "A", 12, 2, "2026-06-01", "TARGET"),
        row("target.pdf", "B", 18, 1, "2026-06-01", "TARGET"),
        *refs("A", (9, 10, 11)),
        *refs("B", (19, 20, 21), sources=("b1", "b2", "b3"), offers=("B1", "B2", "B3")),
    ]
    result = metric(rows, dn("A", "B"))

    assert result["PV_avg_pct_wert"] == pytest.approx(5.0)
    assert result["PV_avg_pct_pos"] == pytest.approx(5.0)
    assert result["comparison_quality"] == {
        "method_version": METRICS_VERSION,
        "as_of": "2026-11-26",
        "window_start": "2023-11-26",
        "status": "reliable",
        "reason": None,
        "total_positions": 2,
        "eligible_positions": 2,
        "matched_positions": 2,
        "excluded_positions": 0,
        "reference_offer_count": 6,
        "value_coverage_pct": 100.0,
        "position_coverage_pct": 100.0,
    }


def test_duplicate_offer_numbers_are_one_vote_and_self_offer_is_excluded() -> None:
    rows = [row("target.pdf", "A", 10, 1, "2026-06-01", "SELF")]
    rows += refs(
        "A",
        (8, 12, 10, 10),
        dates=("2025-01-10", "2025-01-10", "2025-03-10", "2025-04-10"),
        sources=("dup-a", "dup-b", "self-copy", "other"),
        offers=("DUP", "DUP", "SELF", "OTHER"),
    )
    result = metric(rows, dn("A"))

    assert result["PV_avg_pct_wert"] is None
    assert result["comparison_quality"]["reason"] == "insufficient_references"
    assert result["comparison_quality"]["reference_offer_count"] == 2


def test_window_is_current_36_months_strictly_before_target_and_first_only() -> None:
    rows = [row("target.pdf", "A", 10, 1, "2026-01-15", "TARGET")]
    rows += refs(
        "A",
        (8, 10, 12, 100, 100, 100),
        dates=("2023-11-26", "2024-06-01", "2025-10-01", "2023-11-25", "2026-01-15", "2026-02-01"),
        offers=("EDGE", "MID", "RECENT", "TOO-OLD", "SAME-DAY", "FUTURE"),
        sources=("edge", "mid", "recent", "old", "same", "future"),
    )
    rows.append(row("follow", "A", 100, 1, "2025-11-01", "FOLLOW", offer_type="Folgeangebot"))
    result = metric(rows, dn("A"))

    assert result["PV_avg_pct_wert"] == pytest.approx(0.0)
    assert result["comparison_quality"]["reference_offer_count"] == 3


def test_leap_day_and_aware_datetime_use_berlin_calendar_date() -> None:
    rows = [row("target.pdf", "A", 10, 1, "2028-02-28", "TARGET")]
    rows += refs(
        "A",
        (8, 10, 12, 100),
        dates=("2025-03-01", "2026-01-01", "2027-01-01", "2025-02-28"),
    )
    result = metric(
        rows,
        dn("A"),
        as_of=datetime(2028, 2, 29, 23, 30, tzinfo=timezone.utc),
    )

    assert result["comparison_quality"]["as_of"] == "2028-03-01"
    assert result["comparison_quality"]["window_start"] == "2025-03-01"
    assert result["comparison_quality"]["reference_offer_count"] == 3
    assert result["comparison_quality"]["status"] == "reliable"


@pytest.mark.parametrize(
    ("matched_value", "status", "reason"),
    [
        (49.99, "unavailable", "insufficient_coverage"),
        (50.0, "reliable", None),
        (50.01, "reliable", None),
        (55.0, "reliable", None),
        (60.0, "reliable", None),
    ],
)
def test_fifty_percent_value_coverage_boundary(matched_value, status, reason) -> None:
    other_value = 100.0 - matched_value
    rows = [
        row("target.pdf", "A", matched_value, 1, "2026-06-01", "TARGET"),
        row("target.pdf", "B", other_value, 1, "2026-06-01", "TARGET"),
        *refs("A", (matched_value,) * 3),
        *refs("B", (other_value,) * 2, sources=("b1", "b2"), offers=("B1", "B2")),
    ]
    result = metric(rows, dn("A", "B"))

    assert result["comparison_quality"]["status"] == status
    assert result["comparison_quality"]["reason"] == reason
    assert result["comparison_quality"]["value_coverage_pct"] == pytest.approx(matched_value)
    assert (result["PV_avg_pct_wert"] is not None) is (status == "reliable")


def test_fifty_percent_value_coverage_is_reliable_with_many_unmatched_positions() -> None:
    edge_articles = tuple(f"EDGE-{index:03d}" for index in range(50))
    rows = [
        row("target.pdf", "CORE", 50, 1, "2026-06-01", "TARGET"),
        *(
            row("target.pdf", article, 1, 1, "2026-06-01", "TARGET")
            for article in edge_articles
        ),
        *refs("CORE", (50, 50, 50)),
    ]

    result = metric(rows, dn("CORE", *edge_articles))

    quality = result["comparison_quality"]
    assert quality["status"] == "reliable"
    assert quality["reason"] is None
    assert quality["eligible_positions"] == 51
    assert quality["matched_positions"] == 1
    assert quality["value_coverage_pct"] == pytest.approx(50.0)
    assert quality["position_coverage_pct"] == pytest.approx(100 / 51)
    assert result["PV_avg_pct_wert"] == pytest.approx(0.0)
    assert result["PV_avg_pct_pos"] == pytest.approx(0.0)


def test_corrupt_and_unverified_rows_do_not_inflate_coverage_denominator() -> None:
    rows = [
        row("target.pdf", "A", 10, 1, "2026-06-01", "TARGET", total=100),
        row(
            "target.pdf",
            "6000016",
            600001695.001,
            675,
            "2026-06-01",
            "TARGET",
            total=100,
            raw_price=600001695.001,
            unit="Stück",
        ),
        row("target.pdf", "SPECIAL", 1000, 10, "2026-06-01", "TARGET", total=100),
        *refs("A", (9, 10, 11)),
    ]
    result = metric(rows, dn("A", "6000016", unit="Meter"))

    assert result["PV_avg_pct_wert"] == pytest.approx(0.0)
    quality = result["comparison_quality"]
    assert quality["total_positions"] == 3
    assert quality["eligible_positions"] == 1
    assert quality["excluded_positions"] == 2
    assert quality["value_coverage_pct"] == 100.0


def test_manual_override_bypasses_raw_flags_but_not_line_total_plausibility() -> None:
    good = row(
        "target.pdf",
        "6000016",
        10,
        1,
        "2026-06-01",
        "TARGET",
        raw_price=600001695.001,
        validated=False,
        manual=True,
        total=100,
    )
    rows = [good, *refs("6000016", (9, 10, 11))]
    assert metric(rows, dn("6000016"))["comparison_quality"]["status"] == "reliable"

    good["Preis"] = 2_000
    assert metric(rows, dn("6000016"))["comparison_quality"]["reason"] == "invalid_prices"


def test_units_validation_flag_and_price_unit_exclude_invalid_rows() -> None:
    rows = [
        row("target.pdf", "A", 10, 1, "2026-06-01", "TARGET", unit="Meter"),
        row("target.pdf", "B", 10, 1, "2026-06-01", "TARGET", unit="Stück"),
        row("target.pdf", "C", 10, 1, "2026-06-01", "TARGET", validated=False),
        row("target.pdf", "D", 10, 1, "2026-06-01", "TARGET", price_unit=0),
        *refs("A", (9, 10, 11)),
    ]
    result = metric(rows, dn("A", "B", "C", "D"))

    assert result["comparison_quality"]["status"] == "reliable"
    assert result["comparison_quality"]["eligible_positions"] == 1
    assert result["comparison_quality"]["excluded_positions"] == 3


@pytest.mark.parametrize(
    ("price", "quantity"),
    [
        (0, 1),
        (10, 0),
        (None, 1),
        (10, None),
        (float("nan"), 1),
        (10, float("nan")),
        (float("inf"), 1),
        (10, float("inf")),
    ],
)
def test_nonpositive_or_missing_target_values_are_invalid(price, quantity) -> None:
    result = metric(
        [
            row("target.pdf", "A", price, quantity, "2026-06-01", "TARGET"),
            row("target.pdf", "B", 10, 1, "2026-06-01", "TARGET"),
        ],
        dn("A", "B"),
    )
    assert result["PV_avg_pct_wert"] is None
    assert result["comparison_quality"]["eligible_positions"] == 1
    assert result["comparison_quality"]["excluded_positions"] == 1
    assert result["comparison_quality"]["reason"] == "no_comparable_positions"


def test_no_overlap_and_too_few_references_have_distinct_reasons() -> None:
    target = [row("target.pdf", "A", 10, 1, "2026-06-01", "TARGET")]
    no_overlap = metric(target + refs("B", (9, 10, 11)), dn("A", "B"))
    too_few = metric(target + refs("A", (9, 11)), dn("A"))
    assert no_overlap["comparison_quality"]["reason"] == "no_comparable_positions"
    assert too_few["comparison_quality"]["reason"] == "insufficient_references"


def test_no_first_offer_reference_rows_is_unavailable_without_error() -> None:
    rows = [
        row(
            "target.pdf",
            "A",
            10,
            1,
            "2026-06-01",
            "TARGET",
            offer_type="Folgeangebot",
        )
    ]
    result = metric(rows, dn("A"))
    assert result["comparison_quality"]["reason"] == "no_comparable_positions"


@pytest.mark.parametrize("target_date", [None, "2026-11-27"])
def test_missing_or_future_target_date_is_invalid(target_date) -> None:
    result = metric([row("target.pdf", "A", 10, 1, target_date, "TARGET")], dn("A"))
    assert result["comparison_quality"]["reason"] == "invalid_date"


def test_conflicting_target_dates_are_invalid() -> None:
    rows = [
        row("target.pdf", "A", 10, 1, "2026-06-01", "TARGET"),
        row("target.pdf", "B", 10, 1, "2026-06-02", "TARGET"),
        *refs("A", (9, 10, 11)),
    ]
    result = metric(rows, dn("A", "B"))
    assert result["comparison_quality"]["reason"] == "invalid_date"


def test_reference_offer_with_conflicting_dates_is_not_counted() -> None:
    rows = [row("target.pdf", "A", 10, 1, "2026-06-01", "TARGET")]
    rows += refs(
        "A",
        (8, 12, 9, 11),
        dates=("2025-01-10", "2025-01-11", "2025-02-10", "2025-03-10"),
        offers=("DUP", "DUP", "TWO", "THREE"),
        sources=("dup-a", "dup-b", "two", "three"),
    )
    result = metric(rows, dn("A"))
    assert result["comparison_quality"]["reason"] == "insufficient_references"
    assert result["comparison_quality"]["reference_offer_count"] == 2


def test_scaling_splitting_and_row_order_do_not_change_metrics() -> None:
    base = [row("target.pdf", "A", 12, 4, "2026-06-01", "TARGET"), *refs("A", (9, 10, 11))]
    split = [
        row("target.pdf", "A", 12, 1, "2026-06-01", "TARGET"),
        row("target.pdf", "A", 12, 3, "2026-06-01", "TARGET"),
    ]
    for item in base[1:]:
        split += [
            row(item["Quelle"], "A", item["Preis"], 0.25, item["Datum"], item["Angebot"]),
            row(item["Quelle"], "A", item["Preis"], 0.75, item["Datum"], item["Angebot"]),
        ]
    scaled = [
        {**item, "Preis": item["Preis"] * 7, "Gesamt (netto)": item["Gesamt (netto)"] * 7}
        for item in split
    ]

    expected = metric(base, dn("A"))
    actual_split = metric(list(reversed(split)), dn("A"))
    actual_scaled = metric(scaled, dn("A"))
    for key in ("PV_avg_pct_wert", "PV_avg_pct_pos"):
        assert actual_split[key] == pytest.approx(expected[key])
        assert actual_scaled[key] == pytest.approx(expected[key])


def test_source_filter_returns_only_requested_sources() -> None:
    rows = [
        row("one.pdf", "A", 10, 1, "2026-06-01", "ONE"),
        row("two.pdf", "A", 10, 1, "2026-06-01", "TWO"),
        *refs("A", (9, 10, 11)),
    ]
    result = offer_price_metrics(pd.DataFrame(rows), dn("A"), as_of=AS_OF, sources=["two.pdf"])
    assert list(result) == ["two.pdf"]
