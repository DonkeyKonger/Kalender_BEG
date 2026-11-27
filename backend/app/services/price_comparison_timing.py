"""Low-overhead, request-scoped timing for the price-comparison API.

Only fixed metric names are accepted.  This keeps uploaded file names, article
numbers, query values and authentication data out of both ``Server-Timing`` and
application logs.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
import logging
import re
from threading import Lock
from time import perf_counter_ns
from typing import Callable, Iterator

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


LOGGER = logging.getLogger(__name__)

_PRICE_PATH_PREFIX = "/api/price-comparison"
_STAGES = frozenset({
    "snapshot",
    "parsing",
    "prepare",
    "metrics",
    "overview",
    "serialization",
})
_CACHE_NAMES = frozenset({"snapshot", "parsed", "derived", "overview", "online_import"})
_CACHE_LAYERS = frozenset({"memory", "disk", "source"})
_SAFE_OPERATION_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$")
_clock_ns: Callable[[], int] = perf_counter_ns


def _header_token(value: str) -> str:
    return value.replace("_", "-")


@dataclass(slots=True)
class _RequestTiming:
    started_ns: int
    stage_ns: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    stage_counts: Counter[str] = field(default_factory=Counter)
    cache_counts: Counter[tuple[str, str, str]] = field(default_factory=Counter)
    lock: Lock = field(default_factory=Lock)

    def add_stage(self, stage: str, duration_ns: int) -> None:
        with self.lock:
            self.stage_ns[stage] += max(0, duration_ns)
            self.stage_counts[stage] += 1

    def add_cache(self, name: str, layer: str, outcome: str) -> None:
        with self.lock:
            self.cache_counts[(name, layer, outcome)] += 1

    def snapshot(self) -> tuple[dict[str, int], dict[str, int], dict[tuple[str, str, str], int]]:
        with self.lock:
            return dict(self.stage_ns), dict(self.stage_counts), dict(self.cache_counts)


_active_timing: ContextVar[_RequestTiming | None] = ContextVar(
    "price_comparison_request_timing",
    default=None,
)


@contextmanager
def price_timing(stage: str) -> Iterator[None]:
    """Measure a fixed price-comparison stage for the active HTTP request."""

    if stage not in _STAGES:
        raise ValueError(f"Unsupported price-comparison timing stage: {stage!r}")
    timing = _active_timing.get()
    if timing is None:
        yield
        return
    started_ns = _clock_ns()
    try:
        yield
    finally:
        timing.add_stage(stage, _clock_ns() - started_ns)


def record_cache_hit(name: str, layer: str) -> None:
    _record_cache(name, layer, "hit")


def record_cache_miss(name: str, layer: str) -> None:
    _record_cache(name, layer, "miss")


def _record_cache(name: str, layer: str, outcome: str) -> None:
    if name not in _CACHE_NAMES:
        raise ValueError(f"Unsupported price-comparison cache name: {name!r}")
    if layer not in _CACHE_LAYERS:
        raise ValueError(f"Unsupported price-comparison cache layer: {layer!r}")
    timing = _active_timing.get()
    if timing is not None:
        timing.add_cache(name, layer, outcome)


def _server_timing_value(timing: _RequestTiming, total_ns: int) -> str:
    stage_ns, stage_counts, cache_counts = timing.snapshot()
    values = [f"pc-total;dur={_milliseconds(total_ns):.1f}"]
    for stage in sorted(stage_ns):
        metric = f"pc-{_header_token(stage)};dur={_milliseconds(stage_ns[stage]):.1f}"
        if stage_counts[stage] > 1:
            metric += f';desc="{stage_counts[stage]} calls"'
        values.append(metric)
    for (name, layer, outcome), count in sorted(cache_counts.items()):
        values.append(
            f"pc-cache-{_header_token(name)}-{layer}-{outcome};desc=\"{count}\""
        )
    return ", ".join(values)


def _milliseconds(duration_ns: int) -> float:
    return max(0, duration_ns) / 1_000_000


def _operation(scope: Scope) -> str:
    route = scope.get("route")
    name = getattr(route, "name", None)
    if isinstance(name, str) and _SAFE_OPERATION_RE.fullmatch(name):
        return name
    return "unknown"


def _method(scope: Scope) -> str:
    method = str(scope.get("method", "")).upper()
    return method if method in {"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"} else "UNKNOWN"


def _log_request(
    timing: _RequestTiming,
    *,
    method: str,
    operation: str,
    status: int,
    total_ns: int,
) -> None:
    stage_ns, stage_counts, cache_counts = timing.snapshot()
    stages = ",".join(
        f"{stage}:{_milliseconds(duration):.1f}:{stage_counts[stage]}"
        for stage, duration in sorted(stage_ns.items())
    ) or "none"
    caches = ",".join(
        f"{name}.{layer}.{outcome}:{count}"
        for (name, layer, outcome), count in sorted(cache_counts.items())
    ) or "none"
    LOGGER.info(
        "price_comparison_timing operation=%s method=%s status=%d total_ms=%.1f stages=%s caches=%s",
        operation,
        method,
        status,
        _milliseconds(total_ns),
        stages,
        caches,
    )


class PriceComparisonTimingMiddleware:
    """Measure only price-comparison requests without retaining request data."""

    def __init__(self, app: ASGIApp, *, expose_server_timing: bool = True) -> None:
        self.app = app
        self.expose_server_timing = expose_server_timing

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _is_price_comparison_path(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        timing = _RequestTiming(started_ns=_clock_ns())
        token: Token[_RequestTiming | None] = _active_timing.set(timing)
        status = 500
        response_started = False

        async def timed_send(message: Message) -> None:
            nonlocal response_started, status
            if message["type"] == "http.response.start":
                response_started = True
                status = int(message["status"])
                if self.expose_server_timing:
                    headers = MutableHeaders(scope=message)
                    measured = _server_timing_value(timing, _clock_ns() - timing.started_ns)
                    existing = headers.get("server-timing")
                    headers["server-timing"] = f"{existing}, {measured}" if existing else measured
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            total_ns = _clock_ns() - timing.started_ns
            _active_timing.reset(token)
            _log_request(
                timing,
                method=_method(scope),
                operation=_operation(scope),
                status=status if response_started else 500,
                total_ns=total_ns,
            )


def _is_price_comparison_path(path: object) -> bool:
    if not isinstance(path, str):
        return False
    return path == _PRICE_PATH_PREFIX or path.startswith(_PRICE_PATH_PREFIX + "/")
