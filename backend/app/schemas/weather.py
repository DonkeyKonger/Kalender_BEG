from datetime import datetime

from pydantic import BaseModel


class WeatherSummary(BaseModel):
    label: str
    available: bool
    temperature: float | None = None
    temperature_min: float | None = None
    temperature_max: float | None = None
    precipitation_probability: int | None = None
    precipitation_hint: str = "derzeit nicht verfuegbar"
    wind_speed: float | None = None
    summary: str = "derzeit nicht verfuegbar"
    updated_at: datetime | None = None
    is_cached: bool = False
