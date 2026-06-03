from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.enums import GpsSourceType, SiteStatus, UserRole
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.gps import GpsLocationPointCreate
from app.services.geo_service import has_valid_coordinates, is_point_inside_site_geofence


GPS_CAPTURE_FUTURE_TOLERANCE = timedelta(minutes=10)
GPS_REVIEW_SUGGESTION_MINUTES = 30


@dataclass(frozen=True)
class GpsPresenceEvaluation:
    status: str
    matched_points: int
    total_points: int
    reason: str
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    work_minutes: int | None = None
    planned_site_labels: tuple[str, ...] = ()
    gps_detected_site_id: int | None = None
    gps_detected_site_name: str | None = None
    gps_detected_site_number: str | None = None
    gps_detected_location_type: str | None = None
    planned_vs_gps_mismatch: bool = False
    mismatch_notice: str | None = None


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


@dataclass(frozen=True)
class GpsSiteStay:
    person_id: int
    person_name: str
    site_id: int
    site_name: str | None
    site_number: str | None
    work_date: date
    first_seen_at: datetime
    last_seen_at: datetime
    work_minutes: int
    matched_points: int
    planned_site_labels: tuple[str, ...] = ()
    planned_vs_gps_mismatch: bool = False
    mismatch_notice: str | None = None


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
        planned_context = self._planned_gps_context(planned_sites, points[-1] if points else None)
        if not planned_sites:
            return GpsPresenceEvaluation("not_checkable", 0, len(points), "planned_site_missing", **gps_range, **planned_context)
        if not points:
            return GpsPresenceEvaluation("not_checkable", 0, 0, "no_gps_point_for_work_date", **gps_range, **planned_context)

        plausibility = self._evaluate_point_against_planned_sites(points[-1], planned_sites)
        return self._presence_evaluation_from_point_plausibility(
            plausibility,
            gps_range={**gps_range, **planned_context},
        )

    def list_site_stays_for_review(
        self,
        *,
        date_from: date,
        date_to: date,
        person_id: int | None = None,
        site_id: int | None = None,
        min_minutes: int = GPS_REVIEW_SUGGESTION_MINUTES,
    ) -> list[GpsSiteStay]:
        start_at, _ = day_window(date_from)
        _, end_at = day_window(date_to)
        point_statement = (
            select(GpsPoint)
            .where(
                GpsPoint.source_type == GpsSourceType.PHONE,
                GpsPoint.person_id.is_not(None),
                GpsPoint.timestamp >= start_at,
                GpsPoint.timestamp <= end_at,
            )
            .order_by(GpsPoint.person_id, GpsPoint.timestamp, GpsPoint.id)
        )
        if person_id is not None:
            point_statement = point_statement.where(GpsPoint.person_id == person_id)
        points = list(self.db.scalars(point_statement))
        if not points:
            return []

        site_statement = select(Site).where(Site.status == SiteStatus.ACTIVE)
        if site_id is not None:
            site_statement = site_statement.where(Site.id == site_id)
        person_ids = {point.person_id for point in points if point.person_id is not None}
        people = {
            person.id: person
            for person in self.db.scalars(select(Person).where(Person.id.in_(person_ids)))
        }
        assignments = list(self.db.scalars(
            select(Assignment)
            .options(selectinload(Assignment.site))
            .where(
                Assignment.person_id.in_(person_ids),
                Assignment.start_date <= date_to,
                Assignment.end_date >= date_from,
            )
        ))
        active_sites = [site for site in self.db.scalars(site_statement) if has_valid_coordinates(site)]
        active_site_by_id = {site.id: site for site in active_sites}
        grouped_points: dict[tuple[int, date, int], list[GpsPoint]] = {}
        for point in points:
            if point.person_id is None:
                continue
            point_date = ensure_aware_utc(point.timestamp).date()
            planned_sites = planned_sites_from_assignments(assignments, point.person_id, point_date)
            candidate_sites = matching_candidate_sites(active_site_by_id, planned_sites, site_id=site_id)
            planned_site_ids = {site.id for site in planned_sites}
            matched_site = self._matched_site_for_point(point, candidate_sites, planned_site_ids=planned_site_ids)
            if matched_site is None:
                continue
            grouped_points.setdefault((point.person_id, point_date, matched_site.id), []).append(point)

        stays: list[GpsSiteStay] = []
        for (stay_person_id, stay_date, stay_site_id), stay_points in grouped_points.items():
            stay_range = gps_range_from_points(stay_points)
            work_minutes = stay_range["work_minutes"]
            if work_minutes is None or work_minutes < min_minutes:
                continue
            planned_sites = planned_sites_from_assignments(assignments, stay_person_id, stay_date)
            candidate_sites = matching_candidate_sites(active_site_by_id, planned_sites, site_id=site_id)
            site = next((candidate_site for candidate_site in candidate_sites if candidate_site.id == stay_site_id), None)
            if site is None:
                continue
            planned_labels = tuple(site_label(planned_site) for planned_site in planned_sites)
            planned_site_ids = {planned_site.id for planned_site in planned_sites}
            planned_vs_gps_mismatch = bool(planned_sites and stay_site_id not in planned_site_ids)
            mismatch_notice = plan_gps_mismatch_notice(planned_labels, site_label(site)) if planned_vs_gps_mismatch else None
            stays.append(GpsSiteStay(
                person_id=stay_person_id,
                person_name=person_label(people.get(stay_person_id)),
                site_id=site.id,
                site_name=site.name,
                site_number=site.site_number,
                work_date=stay_date,
                first_seen_at=stay_range["first_seen_at"],
                last_seen_at=stay_range["last_seen_at"],
                work_minutes=work_minutes,
                matched_points=len(stay_points),
                planned_site_labels=planned_labels,
                planned_vs_gps_mismatch=planned_vs_gps_mismatch,
                mismatch_notice=mismatch_notice,
            ))
        return sorted(stays, key=lambda stay: (stay.person_name, stay.work_date, stay.site_number or "", stay.site_name or ""))

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

    def _planned_gps_context(self, planned_sites: list[Site], point: GpsPoint | None) -> dict[str, object]:
        planned_labels = tuple(site_label(site) for site in planned_sites)
        candidate_sites = self._matching_candidate_sites(planned_sites)
        planned_site_ids = {site.id for site in planned_sites}
        detected_site = self._matched_site_for_point(point, candidate_sites, planned_site_ids=planned_site_ids) if point is not None else None
        detected_label = site_label(detected_site) if detected_site is not None else None
        planned_vs_gps_mismatch = bool(planned_sites and detected_site is not None and detected_site.id not in planned_site_ids)
        return {
            "planned_site_labels": planned_labels,
            "gps_detected_site_id": detected_site.id if detected_site is not None else None,
            "gps_detected_site_name": detected_site.name if detected_site is not None else None,
            "gps_detected_site_number": detected_site.site_number if detected_site is not None else None,
            "gps_detected_location_type": "site" if detected_site is not None else "unknown",
            "planned_vs_gps_mismatch": planned_vs_gps_mismatch,
            "mismatch_notice": plan_gps_mismatch_notice(planned_labels, detected_label) if planned_vs_gps_mismatch else None,
        }

    def _matching_candidate_sites(self, planned_sites: list[Site]) -> list[Site]:
        active_sites = [
            site
            for site in self.db.scalars(select(Site).where(Site.status == SiteStatus.ACTIVE))
            if has_valid_coordinates(site)
        ]
        return matching_candidate_sites({site.id: site for site in active_sites}, planned_sites)

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
    def _matched_site_for_point(point: GpsPoint, sites: list[Site], *, planned_site_ids: set[int] | None = None) -> Site | None:
        checks = [
            (site, check)
            for site in sites
            if (check := is_point_inside_site_geofence(point, site)).inside
        ]
        if not checks:
            return None
        planned_checks = [(site, check) for site, check in checks if planned_site_ids and site.id in planned_site_ids]
        best_site, _ = min(planned_checks or checks, key=lambda item: item[1].distance_m or float("inf"))
        return best_site

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


def planned_sites_from_assignments(assignments: list[Assignment], person_id: int, work_date: date) -> list[Site]:
    return [
        assignment.site
        for assignment in assignments
        if assignment.person_id == person_id
        and assignment.start_date <= work_date <= assignment.end_date
        and assignment.site is not None
    ]


def matching_candidate_sites(
    active_site_by_id: dict[int, Site],
    planned_sites: list[Site],
    *,
    site_id: int | None = None,
) -> list[Site]:
    candidates = dict(active_site_by_id)
    for planned_site in planned_sites:
        if has_valid_coordinates(planned_site) and (site_id is None or planned_site.id == site_id):
            candidates[planned_site.id] = planned_site
    if site_id is not None:
        return [site for site in candidates.values() if site.id == site_id]
    return list(candidates.values())


def plan_gps_mismatch_notice(planned_labels: tuple[str, ...], detected_label: str | None) -> str:
    planned_text = ", ".join(planned_labels) if planned_labels else "nicht geplant"
    gps_text = detected_label or "unbekannt"
    return f"Geplant: {planned_text} · GPS: {gps_text}"
