from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import GpsSourceType, UserRole
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.gps import GpsLocationPointCreate
from app.services.geo_service import has_valid_coordinates, is_point_inside_site_geofence


GPS_CAPTURE_FUTURE_TOLERANCE = timedelta(minutes=10)


@dataclass(frozen=True)
class GpsPresenceEvaluation:
    status: str
    matched_points: int
    total_points: int
    reason: str


class GpsPresenceService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create_location_point(self, payload: GpsLocationPointCreate, current_user: User) -> GpsPoint:
        person_id = self._effective_person_id(current_user, payload.person_id)
        self._ensure_person_exists(person_id)
        captured_at = ensure_aware_utc(payload.captured_at)
        if captured_at > datetime.now(UTC) + GPS_CAPTURE_FUTURE_TOLERANCE:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "GPS-Zeitpunkt darf nicht in der Zukunft liegen.")

        point = GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id=clean_source_id(payload.device_id, current_user.id),
            person_id=person_id,
            latitude=payload.latitude,
            longitude=payload.longitude,
            timestamp=captured_at,
            accuracy_m=payload.accuracy_meters,
        )
        self.db.add(point)
        self.db.commit()
        self.db.refresh(point)
        return point

    def evaluate_time_entry(self, entry: WorkTimeEntry) -> GpsPresenceEvaluation:
        if entry.site_id is None:
            return GpsPresenceEvaluation("not_checkable", 0, 0, "site_missing")
        start_at, end_at = time_entry_gps_window(entry)
        return self.evaluate_presence(
            person_id=entry.person_id,
            site_id=entry.site_id,
            start_datetime=start_at,
            end_datetime=end_at,
        )

    def evaluate_presence(
        self,
        *,
        person_id: int,
        site_id: int,
        start_datetime: datetime,
        end_datetime: datetime,
    ) -> GpsPresenceEvaluation:
        site = self.db.get(Site, site_id)
        if site is None or not has_valid_coordinates(site):
            return GpsPresenceEvaluation("not_checkable", 0, 0, "site_coordinates_missing")

        points = list(self.db.scalars(
            select(GpsPoint)
            .where(
                GpsPoint.person_id == person_id,
                GpsPoint.timestamp >= ensure_aware_utc(start_datetime),
                GpsPoint.timestamp <= ensure_aware_utc(end_datetime),
            )
            .order_by(GpsPoint.timestamp)
        ))
        total_points = len(points)
        if total_points == 0:
            return GpsPresenceEvaluation("missing", 0, 0, "no_gps_points")

        matched_points = sum(1 for point in points if is_point_inside_site_geofence(point, site).inside)
        presence_status = self._presence_status(total_points=total_points, matched_points=matched_points)
        return GpsPresenceEvaluation(
            presence_status,
            matched_points,
            total_points,
            "gps_points_evaluated",
        )

    def _effective_person_id(self, current_user: User, requested_person_id: int | None) -> int:
        if current_user.role == UserRole.MONTEUR:
            if current_user.person_id is None:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
            if requested_person_id is not None and requested_person_id != current_user.person_id:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Monteure dürfen nur eigene GPS-Punkte senden.")
            return current_user.person_id

        if requested_person_id is not None:
            return requested_person_id
        if current_user.person_id is not None:
            return current_user.person_id
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "person_id ist erforderlich.")

    def _ensure_person_exists(self, person_id: int) -> None:
        if self.db.get(Person, person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")

    @staticmethod
    def _presence_status(*, total_points: int, matched_points: int) -> str:
        if total_points <= 0:
            return "missing"
        if matched_points <= 0:
            return "mismatch"
        if matched_points == total_points:
            return "matched"
        return "partial"


def time_entry_gps_window(entry: WorkTimeEntry) -> tuple[datetime, datetime]:
    if entry.start_time and entry.end_time:
        return (
            datetime.combine(entry.work_date, entry.start_time, tzinfo=UTC),
            datetime.combine(entry.work_date, entry.end_time, tzinfo=UTC),
        )
    return day_window(entry.work_date)


def day_window(work_date: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(work_date, time.min, tzinfo=UTC),
        datetime.combine(work_date, time.max, tzinfo=UTC),
    )


def ensure_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def clean_source_id(device_id: str | None, user_id: int) -> str:
    cleaned = device_id.strip() if isinstance(device_id, str) else ""
    return cleaned[:120] if cleaned else f"user:{user_id}"
