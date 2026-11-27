"""Reliable, read-only offer price-level metrics.

The headline metric compares the current offer's quantities at current prices
with the same quantities at robust historic unit-price medians.  It deliberately
does not persist data, inspect files, or apply display caps.
"""

from __future__ import annotations

from datetime import date, datetime
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd


METRICS_VERSION = "matched-basket-v3"
MIN_REFERENCE_OFFERS = 3
MIN_VALUE_COVERAGE_PCT = 50.0
MAX_LINE_TO_OFFER_TOTAL_RATIO = 10.0
MAX_COMPARISON_CANDIDATES = 250_000
_BERLIN = ZoneInfo("Europe/Berlin")

_UNIT_ALIASES = {
    "m": "m",
    "mtr": "m",
    "meter": "m",
    "metre": "m",
    "lfdm": "m",
    "laufendermeter": "m",
    "st": "piece",
    "stk": "piece",
    "stck": "piece",
    "stueck": "piece",
    "pce": "piece",
    "pc": "piece",
    "pcs": "piece",
    "piece": "piece",
    "kg": "kg",
    "kilogramm": "kg",
    "paar": "pair",
    "pair": "pair",
    "pa": "pair",
    "satz": "set",
    "set": "set",
}


def berlin_today() -> date:
    """Return today's calendar date in the application's business timezone."""

    return datetime.now(_BERLIN).date()


def _missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _text(value: Any) -> str:
    return "" if _missing(value) else str(value).strip()


def _article(value: Any) -> str:
    normalized = re.sub(r"[^0-9A-Za-z]", "", _text(value)).upper()
    return normalized.lstrip("0")


def _number(value: Any) -> float | None:
    if _missing(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _unit(value: Any) -> str:
    raw = _text(value).casefold().replace("ß", "ss")
    raw = raw.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    token = re.sub(r"[^a-z0-9]", "", raw)
    return _UNIT_ALIASES.get(token, token)


def _offer_number(value: Any) -> str:
    return _text(value).casefold()


def _source(value: Any) -> str:
    return _text(value)


def _local_date(value: Any) -> date | None:
    if _missing(value):
        return None
    try:
        timestamp = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(timestamp):
        return None
    if timestamp.tzinfo is not None:
        timestamp = timestamp.tz_convert(_BERLIN)
    return timestamp.date()


def _as_of_date(value: Any) -> date:
    if value is None:
        return berlin_today()
    if isinstance(value, datetime):
        return value.astimezone(_BERLIN).date() if value.tzinfo else value.date()
    if isinstance(value, date):
        return value
    parsed = _local_date(value)
    if parsed is None:
        raise ValueError("as_of must be a valid date or datetime")
    return parsed


def _validated_false(value: Any) -> bool:
    if _missing(value):
        return False
    if isinstance(value, str):
        return value.strip().casefold() in {"0", "false", "nein", "no"}
    try:
        return not bool(value)
    except (TypeError, ValueError):
        return True


def _validated_true(value: Any) -> bool:
    if _missing(value):
        return False
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "ja", "yes"}
    try:
        return bool(value)
    except (TypeError, ValueError):
        return False


def _legacy_prefix_price(article: str, raw_price: float | None) -> bool:
    if not article or raw_price is None or raw_price <= 1_000_000:
        return False
    return str(abs(int(raw_price))).startswith(article)


def _datanorm_units(datanorm: pd.DataFrame | None) -> dict[str, str | None]:
    if not isinstance(datanorm, pd.DataFrame) or datanorm.empty or "Artikelnummer" not in datanorm:
        return {}
    units = datanorm["Einheit"].array if "Einheit" in datanorm else [None] * len(datanorm)
    units_by_article: dict[str, set[str]] = {}
    for raw_article, raw_unit in zip(datanorm["Artikelnummer"].array, units, strict=True):
        article = _article(raw_article)
        if not article:
            continue
        normalized_unit = _unit(raw_unit)
        article_units = units_by_article.setdefault(article, set())
        if normalized_unit:
            article_units.add(normalized_unit)
    return {
        article: next(iter(article_units))
        if len(article_units) == 1
        else ("" if not article_units else None)
        for article, article_units in units_by_article.items()
    }


def _row_is_valid(row: Mapping[str, Any], datanorm_units: dict[str, str | None]) -> bool:
    article = row["_article"]
    price = _number(row["_price"])
    quantity = _number(row["_quantity"])
    if not article or price is None or price <= 0 or quantity is None or quantity <= 0:
        return False
    if article not in datanorm_units or datanorm_units[article] is None:
        return False

    manually_overridden = _validated_true(row.get("Preis_manuell"))
    if (
        not manually_overridden
        and "Preis_validiert" in row
        and _validated_false(row.get("Preis_validiert"))
    ):
        return False

    pdf_unit = _unit(row.get("Einheit (PDF)"))
    dn_unit = datanorm_units[article] or ""
    if pdf_unit and (not dn_unit or pdf_unit != dn_unit):
        return False

    if "Preiseinheit (PDF)" in row and not _missing(row.get("Preiseinheit (PDF)")):
        price_unit = _number(row.get("Preiseinheit (PDF)"))
        if price_unit is None or price_unit <= 0:
            return False

    raw_price = _number(row.get("Preis_raw"))
    if raw_price is None:
        raw_price = price
    if not manually_overridden and _legacy_prefix_price(article, raw_price):
        return False

    offer_total = _number(row.get("Gesamt (netto)"))
    if (
        offer_total is not None
        and offer_total > 0
        and price * quantity > offer_total * MAX_LINE_TO_OFFER_TOTAL_RATIO
    ):
        return False
    return True


def _prepared_prices(
    prices: pd.DataFrame | None,
    datanorm_units: dict[str, str | None],
) -> pd.DataFrame:
    if not isinstance(prices, pd.DataFrame) or prices.empty:
        return pd.DataFrame()
    frame = prices.copy()
    for column in ("Quelle", "Artikelnummer", "Datum", "Preis", "Menge"):
        if column not in frame:
            frame[column] = pd.NA
    frame["_source"] = frame["Quelle"].map(_source)
    frame["_article"] = frame["Artikelnummer"].map(_article)
    frame["_date"] = frame["Datum"].map(_local_date)
    frame["_price"] = frame["Preis"].map(_number)
    frame["_quantity"] = frame["Menge"].map(_number)
    frame["_offer_number"] = frame.get("Angebot", pd.Series(index=frame.index, dtype=object)).map(
        _offer_number
    )
    frame["_offer_type"] = frame.get("Angebotsart", pd.Series(index=frame.index, dtype=object)).map(
        _text
    )
    frame["_offer_key"] = [
        f"offer:{offer_number}" if offer_number else f"source:{source.casefold()}"
        for offer_number, source in zip(frame["_offer_number"], frame["_source"], strict=True)
    ]
    frame["_valid"] = [
        _row_is_valid(row, datanorm_units) for row in frame.to_dict(orient="records")
    ]
    frame["_current_value"] = frame["_price"] * frame["_quantity"]
    return frame


def _quality(
    *,
    as_of: date,
    window_start: date,
    status: str,
    reason: str | None,
    total_positions: int,
    eligible_positions: int,
    matched_positions: int,
    reference_offer_count: int,
    value_coverage_pct: float,
    position_coverage_pct: float,
) -> dict[str, Any]:
    return {
        "method_version": METRICS_VERSION,
        "as_of": as_of.isoformat(),
        "window_start": window_start.isoformat(),
        "status": status,
        "reason": reason,
        "total_positions": int(total_positions),
        "eligible_positions": int(eligible_positions),
        "matched_positions": int(matched_positions),
        "excluded_positions": int(max(0, total_positions - eligible_positions)),
        "reference_offer_count": int(reference_offer_count),
        "value_coverage_pct": float(value_coverage_pct),
        "position_coverage_pct": float(position_coverage_pct),
    }


def _result(
    quality: dict[str, Any], *, value: float | None = None, positions: float | None = None
) -> dict[str, Any]:
    return {
        "PV_avg_pct_wert": value,
        "PV_avg_pct_pos": positions,
        "comparison_quality": quality,
    }


def offer_price_metrics(
    prices: pd.DataFrame,
    datanorm: pd.DataFrame,
    *,
    as_of: Any = None,
    sources: Sequence[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Calculate reliable offer-level historic comparison metrics.

    Reference observations are distinct earlier first offers inside the current
    36-calendar-month window.  The primary result is a matched-basket index;
    the secondary result is the simple mean of matched position deviations.
    """

    as_of_day = _as_of_date(as_of)
    window_start = (pd.Timestamp(as_of_day) - pd.DateOffset(months=36)).date()
    dn_units = _datanorm_units(datanorm)
    frame = _prepared_prices(prices, dn_units)

    reference_votes = pd.DataFrame(columns=["_article", "_offer_key", "_date", "_reference_price"])
    if not frame.empty:
        first_rows = frame[frame["_offer_type"].eq("Erstangebot")]
        dated_first_rows = first_rows[first_rows["_date"].notna()]
        consistent_offer_keys = set(
            dated_first_rows.groupby("_offer_key")["_date"]
            .nunique()
            .loc[lambda counts: counts.eq(1)]
            .index
        )
        reference_rows = first_rows[
            first_rows["_valid"]
            & first_rows["_offer_key"].isin(consistent_offer_keys)
            & first_rows["_date"].notna()
            & first_rows["_date"].ge(window_start)
            & first_rows["_date"].le(as_of_day)
        ].copy()
        if not reference_rows.empty:
            per_source = reference_rows.groupby(
                ["_article", "_offer_key", "_source", "_date"],
                as_index=False,
                sort=False,
            ).agg(_quantity=("_quantity", "sum"), _value=("_current_value", "sum"))
            per_source["_reference_price"] = per_source["_value"] / per_source["_quantity"]
            reference_votes = per_source.groupby(
                ["_article", "_offer_key", "_date"],
                as_index=False,
                sort=False,
            ).agg(_reference_price=("_reference_price", "median"))

    if sources is None:
        target_sources = [] if frame.empty else frame["_source"].drop_duplicates().tolist()
    else:
        target_sources = list(dict.fromkeys(_source(value) for value in sources if _source(value)))

    # Build every target basket once.  The original implementation filtered
    # the full price frame and repeated the same article aggregation for every
    # source.  Keeping source metadata and article baskets in maps preserves
    # the source-local rules while making that work linear in the input size.
    source_contexts: dict[str, dict[str, Any]] = {}
    target_articles_by_source: dict[str, pd.DataFrame] = {}
    eligible_values: dict[str, float] = {}
    if not frame.empty:
        for source_name, target in frame.groupby("_source", sort=False):
            source_contexts[source_name] = {
                "total_positions": int(target["_article"].replace("", pd.NA).nunique()),
                "dates": {value for value in target["_date"] if value is not None},
                "offer_keys": tuple(target["_offer_key"].drop_duplicates()),
            }

        valid_targets = frame[frame["_valid"]]
        if not valid_targets.empty:
            all_target_articles = valid_targets.groupby(
                ["_source", "_article"], as_index=False, sort=False
            ).agg(_quantity=("_quantity", "sum"), _current_value=("_current_value", "sum"))
            all_target_articles["_price"] = (
                all_target_articles["_current_value"] / all_target_articles["_quantity"]
            )
            for source_name, articles in all_target_articles.groupby("_source", sort=False):
                basket = articles.drop(columns="_source").reset_index(drop=True)
                target_articles_by_source[source_name] = basket
                eligible_values[source_name] = float(basket["_current_value"].sum())

    # Join reference observations to all eligible target baskets in one pass.
    # The date and self-offer filters remain source-specific, but the expensive
    # historic article statistics are now two batched group-bys instead of two
    # full-frame scans/group-bys for every offer.
    comparison_targets: list[tuple[str, pd.DataFrame, int]] = []
    target_source_set = set(target_sources)
    reference_rows_by_article = (
        reference_votes["_article"].value_counts(sort=False).to_dict()
        if not reference_votes.empty
        else {}
    )
    for source_name, target_articles in target_articles_by_source.items():
        if source_name not in target_source_set:
            continue
        context = source_contexts[source_name]
        target_dates = context["dates"]
        eligible_value = eligible_values[source_name]
        if (
            len(target_dates) == 1
            and next(iter(target_dates)) <= as_of_day
            and math.isfinite(eligible_value)
            and eligible_value > 0
        ):
            projected_rows = sum(
                reference_rows_by_article.get(article, 0)
                for article in target_articles["_article"]
            )
            if projected_rows == 0:
                continue
            lookup = target_articles[["_article"]].copy()
            lookup.insert(0, "_source", source_name)
            lookup["_target_date"] = next(iter(target_dates))
            comparison_targets.append((source_name, lookup, projected_rows))

    # A popular article can occur in almost every target and reference offer.
    # Bound that many-to-many join without splitting an individual source's
    # basket; source-local medians and distinct-offer counts therefore retain
    # exactly the same inputs as the unbatched calculation.
    comparison_batches: list[list[tuple[str, pd.DataFrame, int]]] = []
    current_batch: list[tuple[str, pd.DataFrame, int]] = []
    current_rows = 0
    for target in comparison_targets:
        projected_rows = target[2]
        if current_batch and current_rows + projected_rows > MAX_COMPARISON_CANDIDATES:
            comparison_batches.append(current_batch)
            current_batch = []
            current_rows = 0
        current_batch.append(target)
        current_rows += projected_rows
    if current_batch:
        comparison_batches.append(current_batch)

    reference_offer_counts: dict[str, int] = {}
    reference_stats_by_source: dict[str, pd.DataFrame] = {}
    for comparison_batch in comparison_batches:
        candidates = pd.concat(
            [lookup for _source, lookup, _rows in comparison_batch],
            ignore_index=True,
        ).merge(
            reference_votes,
            on="_article",
            how="inner",
            sort=False,
        )
        candidates = candidates[candidates["_date"].lt(candidates["_target_date"])]
        if not candidates.empty:
            own_offer_keys = pd.DataFrame(
                [
                    (source_name, offer_key)
                    for source_name, _lookup, _rows in comparison_batch
                    for offer_key in source_contexts[source_name]["offer_keys"]
                ],
                columns=["_source", "_offer_key"],
            )
            own_offer_keys["_own_offer"] = True
            candidates = candidates.merge(
                own_offer_keys,
                on=["_source", "_offer_key"],
                how="left",
                sort=False,
            )
            candidates = candidates[candidates["_own_offer"].isna()]
        if not candidates.empty:
            reference_offer_counts.update(
                {
                    source_name: int(count)
                    for source_name, count in candidates.groupby("_source", sort=False)[
                        "_offer_key"
                    ].nunique().items()
                }
            )
            all_reference_stats = candidates.groupby(
                ["_source", "_article"], as_index=False, sort=False
            ).agg(
                _reference_price=("_reference_price", "median"),
                _reference_count=("_offer_key", "nunique"),
            )
            all_reference_stats = all_reference_stats[
                all_reference_stats["_reference_count"].ge(MIN_REFERENCE_OFFERS)
            ]
            for source_name, stats in all_reference_stats.groupby("_source", sort=False):
                reference_stats_by_source[source_name] = stats.drop(
                    columns="_source"
                ).reset_index(drop=True)

    results: dict[str, dict[str, Any]] = {}
    for source_name in target_sources:
        context = source_contexts.get(source_name)
        total_positions = context["total_positions"] if context is not None else 0

        base_quality = dict(
            as_of=as_of_day,
            window_start=window_start,
            total_positions=total_positions,
            eligible_positions=0,
            matched_positions=0,
            reference_offer_count=0,
            value_coverage_pct=0.0,
            position_coverage_pct=0.0,
        )
        if context is None:
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_prices", **base_quality)
            )
            continue

        target_dates = context["dates"]
        if len(target_dates) != 1 or next(iter(target_dates)) > as_of_day:
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_date", **base_quality)
            )
            continue
        target_articles = target_articles_by_source.get(source_name)
        if target_articles is None or target_articles.empty:
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_prices", **base_quality)
            )
            continue
        eligible_positions = len(target_articles)
        eligible_value = eligible_values[source_name]
        base_quality["eligible_positions"] = eligible_positions
        if not math.isfinite(eligible_value) or eligible_value <= 0:
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_prices", **base_quality)
            )
            continue

        reference_offer_count = reference_offer_counts.get(source_name, 0)
        if reference_offer_count == 0:
            results[source_name] = _result(
                _quality(status="unavailable", reason="no_comparable_positions", **base_quality)
            )
            continue

        base_quality["reference_offer_count"] = reference_offer_count
        stats = reference_stats_by_source.get(source_name)
        if stats is None or stats.empty:
            results[source_name] = _result(
                _quality(status="unavailable", reason="insufficient_references", **base_quality)
            )
            continue

        matched = target_articles.merge(stats, on="_article", how="inner")
        matched_positions = len(matched)
        matched_value = float(matched["_current_value"].sum())
        value_coverage = max(0.0, min(100.0, matched_value / eligible_value * 100.0))
        position_coverage = (
            matched_positions / eligible_positions * 100.0 if eligible_positions else 0.0
        )
        base_quality.update(
            matched_positions=matched_positions,
            value_coverage_pct=value_coverage,
            position_coverage_pct=position_coverage,
        )
        if matched_positions == 0:
            results[source_name] = _result(
                _quality(status="unavailable", reason="insufficient_references", **base_quality)
            )
            continue
        if value_coverage + 1e-12 < MIN_VALUE_COVERAGE_PCT:
            results[source_name] = _result(
                _quality(status="unavailable", reason="insufficient_coverage", **base_quality)
            )
            continue

        reference_value = float((matched["_quantity"] * matched["_reference_price"]).sum())
        if not math.isfinite(reference_value) or reference_value <= 0:
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_prices", **base_quality)
            )
            continue
        basket = (matched_value / reference_value - 1.0) * 100.0
        position_changes = (matched["_price"] / matched["_reference_price"] - 1.0) * 100.0
        position_mean = float(position_changes.mean())
        if not math.isfinite(basket) or not math.isfinite(position_mean):
            results[source_name] = _result(
                _quality(status="unavailable", reason="invalid_prices", **base_quality)
            )
            continue

        results[source_name] = _result(
            _quality(status="reliable", reason=None, **base_quality),
            value=float(basket),
            positions=position_mean,
        )

    return results
