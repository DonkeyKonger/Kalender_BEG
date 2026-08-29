from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload
from zoneinfo import ZoneInfo

from app.models.assignment import Assignment
from app.models.enums import GpsSourceType, SiteStatus
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.vehicle import Vehicle, VehicleAsset, VehiclePositionLog
from app.models.work_time_entry import WorkTimeEntry
from app.services.geo_service import has_valid_coordinates, is_point_inside_site_geofence


GPS_PROCESSING_TIMEZONE = ZoneInfo("Europe/Berlin")
GPS_ALLOWED_START_LOCAL = time(5, 0)
GPS_ALLOWED_END_LOCAL = time(19, 0)
GPS_REVIEW_SUGGESTION_MINUTES = 30
NOTICE_GPS_DIFFERS_FROM_PLAN = "GPS-Aufenthalt weicht von Planungsmatrix ab"
NOTICE_MANUAL_DIFFERS_FROM_GPS = "Gemeldete Baustelle weicht von GPS ab"
NOTICE_MANUAL_DIFFERS_FROM_PLAN = "Stundeneingabe weicht von Planungsmatrix ab"
NOTICE_GPS_NOT_CHECKABLE = "GPS nicht eindeutig prüfbar"


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
    manual_vs_planned_mismatch: bool = False
    manual_vs_gps_mismatch: bool = False
    gps_not_checkable: bool = False
    mismatch_notice: str | None = None
    review_notices: tuple[str, ...] = ()

    @property
    def has_source_mismatch(self) -> bool:
        return self.planned_vs_gps_mismatch or self.manual_vs_planned_mismatch or self.manual_vs_gps_mismatch


@dataclass(frozen=True)
class GpsPointPlausibility:
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
    review_notices: tuple[str, ...] = ()


@dataclass(frozen=True)
class VehicleGpsPoint:
    """A vehicle position normalized for the legacy GPS review calculations."""

    latitude: float
    longitude: float
    timestamp: datetime


GpsReviewPoint = GpsPoint | VehicleGpsPoint


class GpsPresenceService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def evaluate_time_entry(self, entry: WorkTimeEntry) -> GpsPresenceEvaluation:
        if is_current_local_work_date(entry.work_date):
            planned_sites = self._planned_sites_for_person_date(entry.person_id, entry.work_date)
            planned_context = self._planned_gps_context(entry, planned_sites, None)
            return GpsPresenceEvaluation(
                "not_checkable",
                0,
                0,
                "gps_work_time_available_next_day",
                **gps_range_from_points([]),
                **planned_context,
            )

        start_at, end_at = day_window(entry.work_date)
        points = self._location_points_for_person(
            person_id=entry.person_id,
            start_datetime=start_at,
            end_datetime=end_at,
        )
        planned_sites = self._planned_sites_for_person_date(entry.person_id, entry.work_date)
        contact_points = self._site_contact_points(points, planned_sites)
        gps_range = gps_range_from_points(contact_points)
        planned_context = self._planned_gps_context(entry, planned_sites, contact_points[-1] if contact_points else None)
        if not planned_sites:
            return GpsPresenceEvaluation("not_checkable", 0, len(points), "planned_site_missing", **gps_range, **planned_context)
        if not points:
            return GpsPresenceEvaluation("not_checkable", 0, 0, "no_gps_point_for_work_date", **gps_range, **planned_context)
        if not contact_points:
            return GpsPresenceEvaluation("not_checkable", 0, len(points), "no_site_contact_for_work_date", **gps_range, **planned_context)

        plausibility = self._evaluate_point_against_planned_sites(contact_points[-1], planned_sites)
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
        point_rows = self._vehicle_point_rows(
            start_datetime=start_at,
            end_datetime=end_at,
            person_id=person_id,
        )
        if not point_rows:
            return []

        site_statement = select(Site).where(Site.status == SiteStatus.ACTIVE)
        if site_id is not None:
            site_statement = site_statement.where(Site.id == site_id)
        person_ids = {assigned_person_id for _, assigned_person_id in point_rows}
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
        grouped_points: dict[tuple[int, date, int], list[GpsReviewPoint]] = {}
        for point, point_person_id in point_rows:
            point_date = ensure_aware_utc(point.timestamp).date()
            planned_sites = planned_sites_from_assignments(assignments, point_person_id, point_date)
            candidate_sites = matching_candidate_sites(active_site_by_id, planned_sites, site_id=site_id)
            planned_site_ids = {site.id for site in planned_sites}
            matched_site = self._matched_site_for_point(point, candidate_sites, planned_site_ids=planned_site_ids)
            if matched_site is None:
                continue
            grouped_points.setdefault((point_person_id, point_date, matched_site.id), []).append(point)

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
            review_notices = (NOTICE_GPS_DIFFERS_FROM_PLAN,) if planned_vs_gps_mismatch else ()
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
                review_notices=review_notices,
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

        points = self._location_points_for_person(
            person_id=person_id,
            start_datetime=start_datetime,
            end_datetime=end_datetime,
        )
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

    @staticmethod
    def _presence_status(*, total_points: int, matched_points: int) -> str:
        if total_points <= 0:
            return "missing"
        if matched_points <= 0:
            return "mismatch"
        if matched_points == total_points:
            return "matched"
        return "partial"

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

    def _planned_gps_context(
        self,
        entry: WorkTimeEntry,
        planned_sites: list[Site],
        point: GpsReviewPoint | None,
    ) -> dict[str, object]:
        planned_labels = tuple(site_label(site) for site in planned_sites)
        candidate_sites = self._matching_candidate_sites(planned_sites)
        planned_site_ids = {site.id for site in planned_sites}
        detected_site = self._matched_site_for_point(point, candidate_sites, planned_site_ids=planned_site_ids) if point is not None else None
        detected_label = site_label(detected_site) if detected_site is not None else None
        planned_vs_gps_mismatch = bool(planned_sites and detected_site is not None and detected_site.id not in planned_site_ids)
        manual_vs_planned_mismatch = bool(planned_sites and entry.site_id is not None and entry.site_id not in planned_site_ids)
        manual_vs_gps_mismatch = bool(entry.site_id is not None and detected_site is not None and entry.site_id != detected_site.id)
        gps_not_checkable = detected_site is None
        review_notices = source_review_notices(
            planned_vs_gps_mismatch=planned_vs_gps_mismatch,
            manual_vs_planned_mismatch=manual_vs_planned_mismatch,
            manual_vs_gps_mismatch=manual_vs_gps_mismatch,
            gps_not_checkable=gps_not_checkable,
        )
        return {
            "planned_site_labels": planned_labels,
            "gps_detected_site_id": detected_site.id if detected_site is not None else None,
            "gps_detected_site_name": detected_site.name if detected_site is not None else None,
            "gps_detected_site_number": detected_site.site_number if detected_site is not None else None,
            "gps_detected_location_type": "site" if detected_site is not None else "unknown",
            "planned_vs_gps_mismatch": planned_vs_gps_mismatch,
            "manual_vs_planned_mismatch": manual_vs_planned_mismatch,
            "manual_vs_gps_mismatch": manual_vs_gps_mismatch,
            "gps_not_checkable": gps_not_checkable,
            "mismatch_notice": plan_gps_mismatch_notice(planned_labels, detected_label) if planned_vs_gps_mismatch else None,
            "review_notices": review_notices,
        }

    def _matching_candidate_sites(self, planned_sites: list[Site]) -> list[Site]:
        active_sites = [
            site
            for site in self.db.scalars(select(Site).where(Site.status == SiteStatus.ACTIVE))
            if has_valid_coordinates(site)
        ]
        return matching_candidate_sites({site.id: site for site in active_sites}, planned_sites)

    def _site_contact_points(self, points: list[GpsReviewPoint], planned_sites: list[Site]) -> list[GpsReviewPoint]:
        candidate_sites = self._matching_candidate_sites(planned_sites)
        planned_site_ids = {site.id for site in planned_sites}
        return [
            point
            for point in points
            if self._matched_site_for_point(point, candidate_sites, planned_site_ids=planned_site_ids) is not None
        ]

    def _location_points_for_person(
        self,
        *,
        person_id: int,
        start_datetime: datetime,
        end_datetime: datetime,
    ) -> list[GpsReviewPoint]:
        return [
            point
            for point, point_person_id in self._vehicle_point_rows(
                start_datetime=start_datetime,
                end_datetime=end_datetime,
                person_id=person_id,
            )
            if point_person_id == person_id
        ]

    def _vehicle_point_rows(
        self,
        *,
        start_datetime: datetime,
        end_datetime: datetime,
        person_id: int | None = None,
    ) -> list[tuple[GpsReviewPoint, int]]:
        """Return only vehicle-derived positions, including the C-Track store.

        ``GpsPoint`` is retained for historic vehicle imports. New C-Track syncs
        store their positions in ``VehiclePositionLog`` and must remain part of
        the same review path after phone GPS has been removed.
        """
        start_at = ensure_aware_utc(start_datetime)
        end_at = ensure_aware_utc(end_datetime)
        legacy_person_id = func.coalesce(GpsPoint.person_id, Vehicle.assigned_person_id)
        legacy_statement = (
            select(GpsPoint, legacy_person_id)
            .outerjoin(Vehicle, Vehicle.id == GpsPoint.vehicle_id)
            .where(
                GpsPoint.source_type == GpsSourceType.VEHICLE,
                legacy_person_id.is_not(None),
                GpsPoint.timestamp >= start_at,
                GpsPoint.timestamp <= end_at,
            )
            .order_by(GpsPoint.timestamp, GpsPoint.id)
        )
        ctrack_person_id = func.coalesce(Vehicle.assigned_person_id, VehicleAsset.assigned_person_id)
        ctrack_statement = (
            select(VehiclePositionLog, ctrack_person_id)
            .join(VehicleAsset, VehicleAsset.id == VehiclePositionLog.vehicle_asset_id)
            .outerjoin(Vehicle, Vehicle.ctrack_vehicle_asset_id == VehicleAsset.id)
            .where(
                ctrack_person_id.is_not(None),
                VehiclePositionLog.event_time_utc >= start_at,
                VehiclePositionLog.event_time_utc <= end_at,
            )
            .order_by(VehiclePositionLog.event_time_utc, VehiclePositionLog.id)
        )
        if person_id is not None:
            legacy_statement = legacy_statement.where(legacy_person_id == person_id)
            ctrack_statement = ctrack_statement.where(ctrack_person_id == person_id)

        point_rows: list[tuple[GpsReviewPoint, int]] = [
            (point, assigned_person_id)
            for point, assigned_person_id in self.db.execute(legacy_statement)
            if assigned_person_id is not None and is_gps_timestamp_in_allowed_window(point.timestamp)
        ]
        point_rows.extend(
            (
                VehicleGpsPoint(
                    latitude=position.latitude,
                    longitude=position.longitude,
                    timestamp=position.event_time_utc,
                ),
                assigned_person_id,
            )
            for position, assigned_person_id in self.db.execute(ctrack_statement)
            if assigned_person_id is not None and is_gps_timestamp_in_allowed_window(position.event_time_utc)
        )
        return sorted(point_rows, key=lambda item: ensure_aware_utc(item[0].timestamp))

    @staticmethod
    def _evaluate_point_against_planned_sites(point: GpsReviewPoint, planned_sites: list[Site]) -> GpsPointPlausibility:
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
    def _matched_site_for_point(point: GpsReviewPoint, sites: list[Site], *, planned_site_ids: set[int] | None = None) -> Site | None:
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


def is_gps_timestamp_in_allowed_window(value: datetime) -> bool:
    local_time = ensure_aware_utc(value).astimezone(GPS_PROCESSING_TIMEZONE).time()
    return GPS_ALLOWED_START_LOCAL <= local_time < GPS_ALLOWED_END_LOCAL


def current_local_date() -> date:
    return datetime.now(GPS_PROCESSING_TIMEZONE).date()


def is_current_local_work_date(work_date: date) -> bool:
    return work_date == current_local_date()


def gps_range_from_points(points: list[GpsReviewPoint]) -> dict[str, datetime | int | None]:
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


def source_review_notices(
    *,
    planned_vs_gps_mismatch: bool,
    manual_vs_planned_mismatch: bool,
    manual_vs_gps_mismatch: bool,
    gps_not_checkable: bool,
) -> tuple[str, ...]:
    notices: list[str] = []
    if planned_vs_gps_mismatch:
        notices.append(NOTICE_GPS_DIFFERS_FROM_PLAN)
    if manual_vs_gps_mismatch:
        notices.append(NOTICE_MANUAL_DIFFERS_FROM_GPS)
    if manual_vs_planned_mismatch:
        notices.append(NOTICE_MANUAL_DIFFERS_FROM_PLAN)
    if gps_not_checkable:
        notices.append(NOTICE_GPS_NOT_CHECKABLE)
    return tuple(notices)
