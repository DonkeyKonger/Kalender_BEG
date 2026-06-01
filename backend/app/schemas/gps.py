from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


GPS_PRESENCE_STATUSES = {"not_checkable", "missing", "partial", "matched", "mismatch"}


class GpsLocationPointCreate(BaseModel):
    person_id: int | None = None
    captured_at: datetime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_meters: float | None = Field(default=None, ge=0)
    source: str | None = Field(default="mobile", max_length=40)
    device_id: str | None = Field(default=None, max_length=120)


class GpsLocationPointRead(BaseModel):
    id: int
    person_id: int
    captured_at: datetime
    latitude: float
    longitude: float
    accuracy_meters: float | None = None


class GpsRecentLocationPointRead(BaseModel):
    id: int
    person_id: int
    person_name: str
    captured_at: datetime
    planned_site_id: int | None = None
    planned_site_label: str | None = None
    plausibility_status: str
    distance_to_planned_site_m: float | None = None
    geofence_radius_m: int | None = None


class GpsPresenceStatusRead(BaseModel):
    status: str
    matched_points: int
    total_points: int
    reason: str
