from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import Integer, case, cast, extract, func, select
from sqlalchemy.orm import Session

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, PersonType
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBase, SiteMeasurementItem
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.payroll_site_cockpit import (
    PayrollSiteCockpitActionItemRead,
    PayrollSiteCockpitHistoryPointRead,
    PayrollSiteCockpitHistoryRead,
    PayrollSiteCockpitRead,
    PayrollSiteCockpitSiteRead,
    PayrollSiteCockpitTotalsRead,
    PayrollSiteRiskLevel,
)


FORECAST_UNAVAILABLE_REASON = (
    "Keine belastbare Projektlaufzeit oder fachlich bestätigte Prognosebasis vorhanden."
)
OFFER_BUDGET_BASIS = "current_active_released_measurement_base"


@dataclass(frozen=True)
class _MountingEntry:
    person_id: int
    site_id: int
    work_date: date
    work_minutes: int


@dataclass(frozen=True)
class _SiteIdentity:
    id: int
    site_number: str | None
    name: str


class PayrollSiteCockpitService:
    """Build payroll site aggregates without loading GPS data or per-site details."""

    def __init__(
        self,
        db: Session,
        *,
        today_provider: Callable[[], date] = date.today,
    ) -> None:
        self.db = db
        self._today_provider = today_provider

    def get_cockpit(self, *, date_from: date, date_to: date) -> PayrollSiteCockpitRead:
        if date_to < date_from:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "date_to darf nicht vor date_from liegen.",
            )
        if (date_from.year, date_from.month) != (date_to.year, date_to.month):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "date_from und date_to müssen im selben Kalendermonat liegen.",
            )

        budget_as_of = self._today_provider()
        actual_effective_as_of = min(date_to, budget_as_of)
        portfolio_site_ids = self._portfolio_site_ids(
            date_from=date_from,
            date_to=actual_effective_as_of,
        )
        if not portfolio_site_ids:
            return self._empty_cockpit(
                date_from=date_from,
                date_to=date_to,
                actual_effective_as_of=actual_effective_as_of,
                budget_as_of=budget_as_of,
            )

        cumulative_entries = self._load_cumulative_entries(
            site_ids=portfolio_site_ids,
            date_to=actual_effective_as_of,
        )
        actual_by_site, _actual_by_site_date = self._aggregate_actual_minutes(cumulative_entries)
        sites = [
            _SiteIdentity(id=row.id, site_number=row.site_number, name=row.name)
            for row in self.db.execute(
                select(Site.id, Site.site_number, Site.name)
                .where(Site.id.in_(portfolio_site_ids))
                .order_by(Site.name, Site.id)
            ).all()
        ]
        offers_by_site = self._active_offer_minutes_by_site(portfolio_site_ids)

        site_reads = [
            self._site_read(
                site,
                actual_minutes=actual_by_site.get(site.id, 0),
                offer_minutes=offers_by_site.get(site.id),
            )
            for site in sites
        ]
        action_items = self._action_items(site_reads)
        known_offers = [site.offer_minutes for site in site_reads if site.offer_minutes is not None]

        return PayrollSiteCockpitRead(
            date_from=date_from,
            date_to=date_to,
            effective_as_of=actual_effective_as_of,
            offer_budget_basis=OFFER_BUDGET_BASIS,
            offer_budget_as_of=budget_as_of,
            totals=PayrollSiteCockpitTotalsRead(
                offer_minutes=sum(known_offers) if known_offers else None,
                actual_minutes=sum(site.actual_minutes for site in site_reads),
                forecast_minutes=None,
                forecast_reason=FORECAST_UNAVAILABLE_REASON,
                variance_minutes=None,
                site_count=len(site_reads),
                budget_site_count=len(known_offers),
                forecast_site_count=0,
            ),
            sites=site_reads,
            action_items=action_items,
        )

    def get_history(self, *, site_id: int, date_to: date) -> PayrollSiteCockpitHistoryRead:
        site_row = self.db.execute(
            select(Site.id, Site.site_number, Site.name).where(Site.id == site_id)
        ).one_or_none()
        if site_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        site = _SiteIdentity(
            id=site_row.id,
            site_number=site_row.site_number,
            name=site_row.name,
        )

        budget_as_of = self._today_provider()
        actual_effective_as_of = min(date_to, budget_as_of)
        entries = self._load_cumulative_entries(
            site_ids={site_id},
            date_to=actual_effective_as_of,
        )
        _actual_by_site, actual_by_site_date = self._aggregate_actual_minutes(entries)
        daily_minutes = actual_by_site_date.get(site_id, {})
        cumulative_minutes = 0
        points: list[PayrollSiteCockpitHistoryPointRead] = []
        for work_date, actual_minutes in sorted(daily_minutes.items()):
            cumulative_minutes += actual_minutes
            points.append(
                PayrollSiteCockpitHistoryPointRead(
                    date=work_date,
                    actual_minutes=cumulative_minutes,
                    forecast_minutes=None,
                )
            )
        if points and points[-1].date < actual_effective_as_of:
            points.append(
                PayrollSiteCockpitHistoryPointRead(
                    date=actual_effective_as_of,
                    actual_minutes=cumulative_minutes,
                    forecast_minutes=None,
                )
            )

        offer_minutes = self._active_offer_minutes_by_site({site_id}).get(site_id)
        return PayrollSiteCockpitHistoryRead(
            site_id=site.id,
            site_number=site.site_number,
            site_name=site.name,
            date_from=points[0].date if points else actual_effective_as_of,
            date_to=date_to,
            effective_as_of=actual_effective_as_of,
            offer_budget_basis=OFFER_BUDGET_BASIS,
            offer_budget_as_of=budget_as_of,
            offer_minutes=offer_minutes,
            forecast_minutes=None,
            forecast_reason=FORECAST_UNAVAILABLE_REASON,
            points=points,
        )

    def _portfolio_site_ids(
        self,
        *,
        date_from: date,
        date_to: date,
    ) -> set[int]:
        if date_to < date_from:
            return set()
        effective_minutes = self._effective_work_minutes_expression()
        return set(
            self.db.scalars(
                select(WorkTimeEntry.site_id)
                .where(
                    WorkTimeEntry.site_id.is_not(None),
                    WorkTimeEntry.work_date >= date_from,
                    WorkTimeEntry.work_date <= date_to,
                    WorkTimeEntry.source != "gps_suggestion",
                    effective_minutes > 0,
                )
                .distinct()
            ).all()
        )

    def _load_cumulative_entries(
        self,
        *,
        site_ids: set[int],
        date_to: date,
    ) -> list[_MountingEntry]:
        if not site_ids:
            return []
        effective_minutes = self._effective_work_minutes_expression()
        return [
            _MountingEntry(
                person_id=row.person_id,
                site_id=row.site_id,
                work_date=row.work_date,
                work_minutes=int(row.work_minutes),
            )
            for row in self.db.execute(
                select(
                    WorkTimeEntry.person_id,
                    WorkTimeEntry.site_id,
                    WorkTimeEntry.work_date,
                    effective_minutes.label("work_minutes"),
                )
                .where(
                    WorkTimeEntry.site_id.in_(site_ids),
                    WorkTimeEntry.work_date <= date_to,
                    WorkTimeEntry.source != "gps_suggestion",
                    effective_minutes > 0,
                )
                .order_by(WorkTimeEntry.work_date, WorkTimeEntry.id)
            ).all()
        ]

    def _aggregate_actual_minutes(
        self,
        entries: list[_MountingEntry],
    ) -> tuple[dict[int, int], dict[int, dict[date, int]]]:
        external_people_by_site_date = self._external_people_by_site_date(entries)
        actual_by_site: dict[int, int] = defaultdict(int)
        actual_by_site_date: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
        for entry in entries:
            external_person_ids = set(
                external_people_by_site_date.get((entry.site_id, entry.work_date), set())
            )
            external_person_ids.discard(entry.person_id)
            minutes = entry.work_minutes * (1 + len(external_person_ids))
            actual_by_site[entry.site_id] += minutes
            actual_by_site_date[entry.site_id][entry.work_date] += minutes
        return dict(actual_by_site), {
            site_id: dict(minutes_by_date)
            for site_id, minutes_by_date in actual_by_site_date.items()
        }

    def _external_people_by_site_date(
        self,
        entries: list[_MountingEntry],
    ) -> dict[tuple[int, date], set[int]]:
        if not entries:
            return {}
        dates_by_site: dict[int, set[date]] = defaultdict(set)
        for entry in entries:
            dates_by_site[entry.site_id].add(entry.work_date)
        start = min(entry.work_date for entry in entries)
        end = max(entry.work_date for entry in entries)

        assignment_rows = list(
            self.db.execute(
                select(
                    Assignment.site_id,
                    Assignment.person_id,
                    Assignment.start_date,
                    Assignment.end_date,
                )
                .join(Person, Person.id == Assignment.person_id)
                .where(
                    Assignment.site_id.in_(dates_by_site),
                    Assignment.start_date <= end,
                    Assignment.end_date >= start,
                    Person.person_type.in_({PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP}),
                )
            ).all()
        )
        if not assignment_rows:
            return {}

        external_person_ids = {row.person_id for row in assignment_rows}
        absence_rows = list(
            self.db.execute(
                select(Absence.person_id, Absence.start_date, Absence.end_date).where(
                    Absence.person_id.in_(external_person_ids),
                    Absence.status == AbsenceStatus.ACTIVE,
                    Absence.start_date <= end,
                    Absence.end_date >= start,
                )
            ).all()
        )
        absence_ranges_by_person: dict[int, list[tuple[date, date]]] = defaultdict(list)
        for row in absence_rows:
            absence_ranges_by_person[row.person_id].append((row.start_date, row.end_date))

        result: dict[tuple[int, date], set[int]] = defaultdict(set)
        for assignment in assignment_rows:
            for work_date in dates_by_site.get(assignment.site_id, set()):
                if not assignment.start_date <= work_date <= assignment.end_date:
                    continue
                if any(
                    absence_start <= work_date <= absence_end
                    for absence_start, absence_end in absence_ranges_by_person.get(
                        assignment.person_id,
                        [],
                    )
                ):
                    continue
                result[(assignment.site_id, work_date)].add(assignment.person_id)
        return dict(result)

    @staticmethod
    def _effective_work_minutes_expression():
        payroll_start_minutes = (
            cast(extract("hour", WorkTimeEntry.payroll_corrected_start_time), Integer) * 60
            + cast(extract("minute", WorkTimeEntry.payroll_corrected_start_time), Integer)
        )
        payroll_end_minutes = (
            cast(extract("hour", WorkTimeEntry.payroll_corrected_end_time), Integer) * 60
            + cast(extract("minute", WorkTimeEntry.payroll_corrected_end_time), Integer)
        )
        payroll_delta = payroll_end_minutes - payroll_start_minutes
        payroll_gross_minutes = case(
            (payroll_delta < 0, payroll_delta + 24 * 60),
            else_=payroll_delta,
        )
        payroll_break_minutes = func.coalesce(
            WorkTimeEntry.payroll_corrected_break_minutes,
            WorkTimeEntry.break_minutes,
            0,
        )
        payroll_net_minutes = payroll_gross_minutes - payroll_break_minutes
        has_valid_payroll_range = (
            WorkTimeEntry.payroll_corrected_start_time.is_not(None)
            & WorkTimeEntry.payroll_corrected_end_time.is_not(None)
            & (
                WorkTimeEntry.payroll_corrected_start_time
                != WorkTimeEntry.payroll_corrected_end_time
            )
            & (payroll_net_minutes > 0)
        )
        return cast(
            case(
                (
                    WorkTimeEntry.payroll_corrected_work_minutes.is_not(None),
                    WorkTimeEntry.payroll_corrected_work_minutes,
                ),
                (has_valid_payroll_range, payroll_net_minutes),
                (
                    WorkTimeEntry.corrected_work_minutes.is_not(None),
                    WorkTimeEntry.corrected_work_minutes,
                ),
                else_=func.coalesce(WorkTimeEntry.work_minutes, 0),
            ),
            Integer,
        )

    def _active_offer_minutes_by_site(self, site_ids: set[int]) -> dict[int, float]:
        if not site_ids:
            return {}
        bases = list(
            self.db.execute(
                select(SiteMeasurementBase.id, SiteMeasurementBase.site_id)
                .where(
                    SiteMeasurementBase.site_id.in_(site_ids),
                    SiteMeasurementBase.status == "active",
                    SiteMeasurementBase.released_to_mobile.is_(True),
                )
                .order_by(
                    SiteMeasurementBase.site_id,
                    SiteMeasurementBase.created_at.desc(),
                    SiteMeasurementBase.id.desc(),
                )
            ).all()
        )
        active_base_by_site: dict[int, int] = {}
        for base in bases:
            active_base_by_site.setdefault(base.site_id, base.id)
        if not active_base_by_site:
            return {}

        site_id_by_base_id = {
            base_id: site_id for site_id, base_id in active_base_by_site.items()
        }
        items = list(
            self.db.execute(
                select(
                    SiteMeasurementItem.measurement_base_id,
                    SiteMeasurementItem.list_quantity,
                    SiteMeasurementItem.minutes_per_unit,
                ).where(
                    SiteMeasurementItem.measurement_base_id.in_(site_id_by_base_id),
                    SiteMeasurementItem.is_hidden.is_(False),
                )
            ).all()
        )
        totals: dict[int, Decimal] = defaultdict(lambda: Decimal("0"))
        for item in items:
            planned_quantity = item.list_quantity or Decimal("0")
            minutes_per_unit = item.minutes_per_unit or Decimal("0")
            if planned_quantity <= 0 or minutes_per_unit <= 0:
                continue
            site_id = site_id_by_base_id.get(item.measurement_base_id)
            if site_id is not None:
                totals[site_id] += planned_quantity * minutes_per_unit
        return {
            site_id: float(minutes)
            for site_id, minutes in totals.items()
            if minutes > 0
        }

    @staticmethod
    def _site_read(
        site: _SiteIdentity,
        *,
        actual_minutes: int,
        offer_minutes: float | None,
    ) -> PayrollSiteCockpitSiteRead:
        variance_minutes = (
            float(actual_minutes - offer_minutes)
            if offer_minutes is not None
            else None
        )
        utilization_percent = (
            actual_minutes / offer_minutes * 100
            if offer_minutes is not None and offer_minutes > 0
            else None
        )
        risk_level, risk_reason = PayrollSiteCockpitService._risk(
            offer_minutes=offer_minutes,
            actual_minutes=actual_minutes,
            utilization_percent=utilization_percent,
        )
        return PayrollSiteCockpitSiteRead(
            site_id=site.id,
            site_number=site.site_number,
            site_name=site.name,
            offer_minutes=offer_minutes,
            actual_minutes=actual_minutes,
            forecast_minutes=None,
            forecast_reason=FORECAST_UNAVAILABLE_REASON,
            variance_minutes=variance_minutes,
            utilization_percent=utilization_percent,
            risk_level=risk_level,
            risk_reason=risk_reason,
        )

    @staticmethod
    def _risk(
        *,
        offer_minutes: float | None,
        actual_minutes: int,
        utilization_percent: float | None,
    ) -> tuple[PayrollSiteRiskLevel, str | None]:
        if offer_minutes is None or utilization_percent is None:
            return (
                "missing_data",
                "Für die erfassten Ist-Stunden fehlt eine aktive Angebotsbasis.",
            )
        if actual_minutes > offer_minutes:
            return "critical", "Die Ist-Stunden liegen über den Angebotsstunden."
        if utilization_percent >= 85:
            return "warning", "Mindestens 85 % der Angebotsstunden sind verbraucht."
        return "none", None

    @staticmethod
    def _action_items(
        sites: list[PayrollSiteCockpitSiteRead],
    ) -> list[PayrollSiteCockpitActionItemRead]:
        relevant = [site for site in sites if site.risk_level != "none"]

        def sort_key(site: PayrollSiteCockpitSiteRead) -> tuple[int, float, str, int]:
            if site.risk_level == "critical":
                return (0, -(site.variance_minutes or 0), site.site_name.casefold(), site.site_id)
            if site.risk_level == "warning":
                return (1, -(site.utilization_percent or 0), site.site_name.casefold(), site.site_id)
            return (2, -site.actual_minutes, site.site_name.casefold(), site.site_id)

        ordered = sorted(relevant, key=sort_key)[:3]
        return [
            PayrollSiteCockpitActionItemRead(
                rank=index,
                site_id=site.site_id,
                site_number=site.site_number,
                site_name=site.site_name,
                risk_level=site.risk_level,
                reason=site.risk_reason or "Prüfung erforderlich.",
                variance_minutes=site.variance_minutes,
                utilization_percent=site.utilization_percent,
            )
            for index, site in enumerate(ordered, start=1)
        ]

    @staticmethod
    def _empty_cockpit(
        *,
        date_from: date,
        date_to: date,
        actual_effective_as_of: date,
        budget_as_of: date,
    ) -> PayrollSiteCockpitRead:
        return PayrollSiteCockpitRead(
            date_from=date_from,
            date_to=date_to,
            effective_as_of=actual_effective_as_of,
            offer_budget_basis=OFFER_BUDGET_BASIS,
            offer_budget_as_of=budget_as_of,
            totals=PayrollSiteCockpitTotalsRead(
                offer_minutes=None,
                actual_minutes=0,
                forecast_minutes=None,
                forecast_reason=FORECAST_UNAVAILABLE_REASON,
                variance_minutes=None,
                site_count=0,
                budget_site_count=0,
                forecast_site_count=0,
            ),
            sites=[],
            action_items=[],
        )
