from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode
from urllib.request import urlopen

from app.core.config import settings
from app.schemas.weather import WeatherSummary

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

_cached_weather: WeatherSummary | None = None
_cached_until: datetime | None = None


class WeatherService:
    """Fetches and caches simple company-location weather for the dashboard."""

    def get_company_weather(self) -> WeatherSummary:
        global _cached_until, _cached_weather

        now = datetime.now(UTC)
        if _cached_weather is not None and _cached_until is not None and now < _cached_until:
            return _cached_weather.model_copy(update={"is_cached": True})

        try:
            weather = self._fetch_company_weather(now)
        except Exception:
            if _cached_weather is not None:
                return _cached_weather.model_copy(update={"is_cached": True})
            return WeatherSummary(
                label=settings.company_location_label,
                available=False,
                summary="derzeit nicht verfuegbar",
                updated_at=now,
            )

        _cached_weather = weather
        _cached_until = now + timedelta(minutes=settings.weather_cache_ttl_minutes)
        return weather

    def _fetch_company_weather(self, now: datetime) -> WeatherSummary:
        params = urlencode(
            {
                "latitude": settings.company_location_lat,
                "longitude": settings.company_location_lon,
                "current": "temperature_2m,precipitation,wind_speed_10m",
                "daily": "temperature_2m_min,temperature_2m_max,precipitation_probability_max",
                "timezone": "Europe/Berlin",
                "forecast_days": 1,
            }
        )
        with urlopen(
            f"{OPEN_METEO_FORECAST_URL}?{params}",
            timeout=settings.weather_request_timeout_seconds,
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))

        current = payload.get("current", {})
        daily = payload.get("daily", {})
        temperature = _as_float(current.get("temperature_2m"))
        wind_speed = _as_float(current.get("wind_speed_10m"))
        temperature_min = _first_float(daily.get("temperature_2m_min"))
        temperature_max = _first_float(daily.get("temperature_2m_max"))
        precipitation_probability = _first_int(daily.get("precipitation_probability_max"))
        precipitation_hint = _precipitation_hint(
            precipitation_probability,
            _as_float(current.get("precipitation")),
        )

        return WeatherSummary(
            label=settings.company_location_label,
            available=(
                temperature is not None
                or temperature_min is not None
                or temperature_max is not None
            ),
            temperature=temperature,
            temperature_min=temperature_min,
            temperature_max=temperature_max,
            precipitation_probability=precipitation_probability,
            precipitation_hint=precipitation_hint,
            wind_speed=wind_speed,
            summary=_build_summary(temperature, precipitation_hint, wind_speed),
            updated_at=now,
        )


def _build_summary(
    temperature: float | None,
    precipitation_hint: str,
    wind_speed: float | None,
) -> str:
    parts: list[str] = []
    if temperature is not None:
        parts.append(f"{round(temperature)}°C")
    parts.append(precipitation_hint)
    if wind_speed is not None:
        parts.append(f"Wind {round(wind_speed)} km/h")
    return " · ".join(parts) if parts else "derzeit nicht verfuegbar"


def _precipitation_hint(probability: int | None, precipitation: float | None) -> str:
    if precipitation is not None and precipitation > 0:
        return "Regen aktuell"
    if probability is None:
        return "Niederschlag unklar"
    if probability >= 70:
        return "Regen wahrscheinlich"
    if probability >= 35:
        return "Regen moeglich"
    return "trocken"


def _first_float(values: object) -> float | None:
    if isinstance(values, list) and values:
        return _as_float(values[0])
    return None


def _first_int(values: object) -> int | None:
    if isinstance(values, list) and values:
        try:
            return int(values[0])
        except (TypeError, ValueError):
            return None
    return None


def _as_float(value: object) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None
