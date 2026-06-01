from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
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
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    work_minutes: int | None = None


@dataclass(frozen=True)
class GpsPointPlausibility:
    planned_site_id: int | None
    planned_site_label: str | None
    plausibility_status: str
    distance_to_planned_site_m: float | None
    geofence_radius_m: int | None


@dataclass(frozen=True)
class GpsRecentLocationPoint:
    id: int
    person_id: int
    person_name: str
    captured_at: datetime
    planned_site_id: int | None
    planned_site_label: str | None
    plausibility_status: str
    distance_to_planned_site_m: float | None
    geofence_radius_m: int | None


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

    def list_recent_location_points(self, *, limit: int = 20) -> list[GpsRecentLocationPoint]:
        safe_limit = max(1, min(limit, 100))
        points = list(self.db.scalars(
            select(GpsPoint)
            .where(
                GpsPoint.source_type == GpsSourceType.PHONE,
                GpsPoint.person_id.is_not(None),
            )
            .order_by(GpsPoint.timestamp.desc(), GpsPoint.id.desc())
            .limit(safe_limit)
        ))
        if not points:
            return []

        person_ids = {point.person_id for point in points if point.person_id is not None}
        people = {
            person.id: person
            for person in self.db.scalars(select(Person).where(Person.id.in_(person_ids)))
        }
        point_dates = [ensure_aware_utc(point.timestamp).date() for point in points]
        assignments = list(self.db.scalars(
            select(Assignment)
            .options(selectinload(Assignment.site))
            .where(
                Assignment.person_id.in_(person_ids),
                Assignment.start_date <= max(point_dates),
                Assignment.end_date >= min(point_dates),
            )
        ))

        return [
            self._recent_location_point(point, people, assignments)
            for point in points
            if point.person_id is not None
        ]

    def evaluate_time_entry(self, entry: WorkTimeEntry) -> GpsPresenceEvaluation:
        start_at, end_at = day_window(entry.work_date)
        points = self._location_points_for_person(
            person_id=entry.person_id,
            start_datetime=start_at,
            end_datetime=end_at,
        )
        gps_range = gps_range_from_points(points)
        planned_sites = self._planned_sites_for_person_date(entry.person_id, entry.work_date)
        if not planned_sites:
            return GpsPresenceEvaluation("not_checkable", 0, len(points), "planned_site_missing", **gps_range)
        if not points:
            return GpsPresenceEvaluation("not_checkable", 0, 0, "no_gps_point_for_work_date")

        plausibility = self._evaluate_point_against_planned_sites(points[-1], planned_sites)
        return self._presence_evaluation_from_point_plausibility(plausibility, gps_range=gps_range)

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

    def _recent_location_point(
        self,
        point: GpsPoint,
        people: dict[int, Person],
        assignments: list[Assignment],
    ) -> GpsRecentLocationPoint:
        point_day = ensure_aware_utc(point.timestamp).date()
        planned_sites = [
            assignment.site
            for assignment in assignments
            if assignment.person_id == point.person_id
            and assignment.start_date <= point_day <= assignment.end_date
            and assignment.site is not None
        ]
        plausibility = self._evaluate_point_against_planned_sites(point, planned_sites)
        person = people.get(point.person_id) if point.person_id is not None else None
        return GpsRecentLocationPoint(
            id=point.id,
            person_id=point.person_id or 0,
            person_name=person_label(person),
            captured_at=point.timestamp,
            planned_site_id=plausibility.planned_site_id,
            planned_site_label=plausibility.planned_site_label,
            plausibility_status=plausibility.plausibility_status,
            distance_to_planned_site_m=plausibility.distance_to_planned_site_m,
            geofence_radius_m=plausibility.geofence_radius_m,
        )

    def _planned_sites_for_person_date(self, person_id: int, work_date: date) -> list[Site]:
        return [
            assignment.site
            for assignment in self.db.scalars(
                select(Assignment)
                .options(selectinload(Assignment.site))
                .where(
                    Assignment.person_id == person_id,
                    Assignment.start_date <= work_date,
                    Assignment.end_date >= work_date,
                )
            )
            if assignment.site is not None
        ]

    def _location_points_for_person(
        self,
        *,
        person_id: int,
        start_datetime: datetime,
        end_datetime: datetime,
    ) -> list[GpsPoint]:
        return list(self.db.scalars(
            select(GpsPoint)
            .where(
                GpsPoint.source_type == GpsSourceType.PHONE,
                GpsPoint.person_id == person_id,
                GpsPoint.timestamp >= ensure_aware_utc(start_datetime),
                GpsPoint.timestamp <= ensure_aware_utc(end_datetime),
            )
            .order_by(GpsPoint.timestamp, GpsPoint.id)
        ))

    @staticmethod
    def _evaluate_point_against_planned_sites(point: GpsPoint, planned_sites: list[Site]) -> GpsPointPlausibility:
        if not planned_sites:
            return GpsPointPlausibility(None, None, "not_checkable", None, None)

        fallback_site = planned_sites[0]
        checks = [
            (site, check)
            for site in planned_sites
            if (check := is_point_inside_site_geofence(point, site)).distance_m is not None
        ]
        if not checks:
            return GpsPointPlausibility(
                fallback_site.id,
                site_label(fallback_site),
                "not_checkable",
                None,
                fallback_site.geofence_radius_m,
            )

        matching_checks = [(site, check) for site, check in checks if check.inside]
        best_site, best_check = min(matching_checks or checks, key=lambda item: item[1].distance_m or float("inf"))
        return GpsPointPlausibility(
            best_site.id,
            site_label(best_site),
            "matched" if best_check.inside else "mismatch",
            best_check.distance_m,
            best_check.radius_m,
        )

    @staticmethod
    def _presence_evaluation_from_point_plausibility(
        plausibility: GpsPointPlausibility,
        *,
        gps_range: dict[str, datetime | int | None] | None = None,
    ) -> GpsPresenceEvaluation:
        range_values = gps_range or {}
        if plausibility.plausibility_status == "matched":
            return GpsPresenceEvaluation("matched", 1, 1, "latest_gps_point_inside_planned_site", **range_values)
        if plausibility.plausibility_status == "mismatch":
            return GpsPresenceEvaluation("mismatch", 0, 1, "latest_gps_point_outside_planned_site", **range_values)
        return GpsPresenceEvaluation("not_checkable", 0, 0, "planned_site_not_checkable", **range_values)


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


def gps_range_from_points(points: list[GpsPoint]) -> dict[str, datetime | int | None]:
    if not points:
        return {"first_seen_at": None, "last_seen_at": None, "work_minutes": None}

    first_seen_at = points[0].timestamp
    last_seen_at = points[-1].timestamp
    work_minutes = None
    if len(points) >= 2:
        duration_seconds = (ensure_aware_utc(last_seen_at) - ensure_aware_utc(first_seen_at)).total_seconds()
        work_minutes = max(0, int(duration_seconds // 60))
    return {
        "first_seen_at": first_seen_at,
        "last_seen_at": last_seen_at,
        "work_minutes": work_minutes,
    }


def person_label(person: Person | None) -> str:
    if person is None:
        return "Unbekannte Person"
    return person.display_name or f"{person.first_name} {person.last_name}".strip() or person.short_code


def site_label(site: Site) -> str:
    if site.site_number and site.name:
        return f"{site.site_number} - {site.name}"
    return site.site_number or site.name
