from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.services.price_comparison_timing import (
    PriceComparisonTimingMiddleware,
    price_timing,
    record_cache_hit,
    record_cache_miss,
)


def _scope(path: str, *, kind: str = "hit") -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"token=must-not-be-logged",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 443),
        "state": {"kind": kind},
    }


async def _receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


def _header(messages: list[dict], name: bytes) -> str | None:
    start = next(message for message in messages if message["type"] == "http.response.start")
    for key, value in start["headers"]:
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def _sender(messages: list[dict]):
    async def send(message: dict) -> None:
        messages.append(message)

    return send


def test_overlapping_requests_keep_timing_and_cache_results_isolated(caplog) -> None:
    async def exercise() -> tuple[list[dict], list[dict]]:
        first_ready = asyncio.Event()
        second_ready = asyncio.Event()

        async def endpoint(scope, _receive, send) -> None:
            with price_timing("snapshot"):
                if scope["state"]["kind"] == "hit":
                    record_cache_hit("overview", "disk")
                    first_ready.set()
                    await second_ready.wait()
                else:
                    record_cache_miss("overview", "disk")
                    second_ready.set()
                    await first_ready.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})

        middleware = PriceComparisonTimingMiddleware(endpoint)
        first_messages: list[dict] = []
        second_messages: list[dict] = []
        await asyncio.gather(
            middleware(
                _scope("/api/price-comparison/offers/private-first.pdf", kind="hit"),
                _receive,
                _sender(first_messages),
            ),
            middleware(
                _scope("/api/price-comparison/articles/secret-4711", kind="miss"),
                _receive,
                _sender(second_messages),
            ),
        )
        return first_messages, second_messages

    caplog.set_level(logging.INFO, logger="app.services.price_comparison_timing")
    first_messages, second_messages = asyncio.run(exercise())

    first_header = _header(first_messages, b"server-timing")
    second_header = _header(second_messages, b"server-timing")
    assert first_header is not None and "pc-snapshot;dur=" in first_header
    assert "pc-cache-overview-disk-hit" in first_header
    assert "pc-cache-overview-disk-miss" not in first_header
    assert second_header is not None and "pc-snapshot;dur=" in second_header
    assert "pc-cache-overview-disk-miss" in second_header
    assert "pc-cache-overview-disk-hit" not in second_header
    assert "private-first.pdf" not in caplog.text
    assert "secret-4711" not in caplog.text
    assert "must-not-be-logged" not in caplog.text


def test_middleware_preserves_existing_server_timing_and_can_hide_its_metrics() -> None:
    async def endpoint(_scope, _receive, send) -> None:
        with price_timing("metrics"):
            pass
        await send({
            "type": "http.response.start",
            "status": 204,
            "headers": [(b"server-timing", b"upstream;dur=1")],
        })
        await send({"type": "http.response.body", "body": b""})

    async def exercise(expose: bool) -> list[dict]:
        messages: list[dict] = []
        await PriceComparisonTimingMiddleware(
            endpoint,
            expose_server_timing=expose,
        )(_scope("/api/price-comparison/offers"), _receive, _sender(messages))
        return messages

    messages = asyncio.run(exercise(True))
    header = _header(messages, b"server-timing")
    assert header is not None
    assert header.startswith("upstream;dur=1, pc-total;dur=")
    assert "pc-metrics;dur=" in header

    hidden_messages = asyncio.run(exercise(False))
    assert _header(hidden_messages, b"server-timing") == "upstream;dur=1"


def test_non_price_routes_are_not_instrumented(caplog) -> None:
    async def endpoint(_scope, _receive, send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def exercise() -> list[dict]:
        messages: list[dict] = []
        await PriceComparisonTimingMiddleware(endpoint)(
            _scope("/api/sites"), _receive, _sender(messages),
        )
        return messages

    caplog.set_level(logging.INFO, logger="app.services.price_comparison_timing")
    messages = asyncio.run(exercise())

    assert _header(messages, b"server-timing") is None
    assert "price_comparison_timing" not in caplog.text


def test_fastapi_sync_route_keeps_context_and_logs_only_static_route_name(caplog) -> None:
    app = FastAPI()
    app.add_middleware(PriceComparisonTimingMiddleware)

    @app.get("/api/price-comparison/offers/{source}", name="offer_summary")
    def offer_summary(source: str) -> dict[str, bool]:
        assert source
        with price_timing("snapshot"):
            record_cache_hit("snapshot", "memory")
        return {"ok": True}

    caplog.set_level(logging.INFO, logger="app.services.price_comparison_timing")
    response = TestClient(app).get(
        "/api/price-comparison/offers/private-customer-offer.pdf?access_token=secret"
    )

    assert response.status_code == 200
    assert "pc-snapshot;dur=" in response.headers["server-timing"]
    assert "pc-cache-snapshot-memory-hit" in response.headers["server-timing"]
    timing_log = "\n".join(
        record.getMessage()
        for record in caplog.records
        if record.name == "app.services.price_comparison_timing"
    )
    assert "operation=offer_summary" in timing_log
    assert "private-customer-offer.pdf" not in timing_log
    assert "access_token" not in timing_log
    assert "secret" not in timing_log


@pytest.mark.parametrize(
    "callback",
    [
        lambda: price_timing("private.pdf"),
        lambda: record_cache_hit("private.pdf", "disk"),
        lambda: record_cache_miss("overview", "tenant-secret"),
    ],
)
def test_dynamic_metric_names_are_rejected(callback) -> None:
    with pytest.raises(ValueError):
        value = callback()
        if hasattr(value, "__enter__"):
            with value:
                pass

