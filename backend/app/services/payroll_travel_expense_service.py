from __future__ import annotations

import calendar
from collections import defaultdict
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from app.models.enums import OvernightStatus
from app.models.person_work_day import PersonWorkDay


HOTEL_STATUSES = frozenset((OvernightStatus.BEG_PAID, OvernightStatus.SELF_PAID))


@dataclass(frozen=True)
class PayrollTravelDay:
    overnight_status: OvernightStatus | None
    has_activity: bool
    has_conflict: bool = False


@dataclass(frozen=True)
class PayrollTravelMarkings:
    travel_10: bool = False
    travel_14: bool = False
    travel_28: bool = False
    overnight_20: bool = False


@dataclass(frozen=True)
class PayrollTravelWarning:
    person_id: int
    work_date: date
    code: str


@dataclass(frozen=True)
class PayrollTravelPlan:
    markings: dict[date, PayrollTravelMarkings]
    warnings: tuple[PayrollTravelWarning, ...]


def aggregate_payroll_travel_days(
    *,
    person_id: int,
    activity_dates: Collection[date],
    work_days: Sequence[PersonWorkDay],
) -> dict[date, PayrollTravelDay]:
    """Verbindliche Tagesangaben sammeln; null ist nicht die Auswahl 'zu Hause'."""
    statuses_by_date: dict[date, set[OvernightStatus]] = defaultdict(set)
    for work_date in activity_dates:
        statuses_by_date[work_date]
    for work_day in work_days:
        if work_day.person_id != person_id:
            continue
        statuses = statuses_by_date[work_day.work_date]
        if work_day.overnight_status is not None:
            statuses.add(OvernightStatus(work_day.overnight_status))
    return {
        work_date: PayrollTravelDay(
            overnight_status=next(iter(statuses)) if len(statuses) == 1 else None,
            has_activity=work_date in activity_dates,
            has_conflict=len(statuses) > 1,
        )
        for work_date, statuses in statuses_by_date.items()
    }


def build_payroll_travel_plan(
    *,
    person_id: int,
    year: int,
    month: int,
    days: Mapping[date, PayrollTravelDay],
) -> PayrollTravelPlan:
    """Reisekosten ohne Excel-Zelladressen oder Änderungen an Arbeitsstunden.

    Benachbarte Hotelnächte gehören unabhängig vom Kostenträger zusammen.
    Der Vortag des Monats ist deshalb zwingender Bestandteil der Quelldaten,
    sofern dort eine Tagesangabe existiert. Eine unklare Tagesangabe wird nie
    als 'zu Hause' oder als sicherer Anfang eines neuen Hotelblocks gewertet.
    """
    markings: dict[date, PayrollTravelMarkings] = {}
    warnings: list[PayrollTravelWarning] = []
    for day_number in range(1, calendar.monthrange(year, month)[1] + 1):
        work_date = date(year, month, day_number)
        markings[work_date] = PayrollTravelMarkings()
        day = days.get(work_date)
        if day is None:
            # Keine Buchung und keine Tagesangabe: keine Reise erfinden.
            continue
        if day.has_conflict or day.overnight_status is None:
            warnings.append(PayrollTravelWarning(
                person_id, work_date,
                "conflicting_overnight_status" if day.has_conflict else "missing_overnight_status",
            ))
            continue

        previous = days.get(work_date - timedelta(days=1))
        previous_is_hotel = (
            previous is not None
            and not previous.has_conflict
            and previous.overnight_status in HOTEL_STATUSES
        )
        if day.overnight_status == OvernightStatus.NONE:
            # Explizit zu Hause: Arbeitstag oder dokumentierter Abreisetag.
            if day.has_activity or previous_is_hotel:
                markings[work_date] = PayrollTravelMarkings(travel_14=True)
            continue

        if previous is not None and (
            previous.has_conflict or previous.overnight_status is None
        ):
            warnings.append(PayrollTravelWarning(
                person_id, work_date, "unclear_hotel_block_start",
            ))
            continue
        if previous_is_hotel:
            markings[work_date] = PayrollTravelMarkings(
                travel_10=True,
                travel_28=True,
                overnight_20=day.overnight_status == OvernightStatus.SELF_PAID,
            )
        else:
            markings[work_date] = PayrollTravelMarkings(travel_14=True, overnight_20=True)
    return PayrollTravelPlan(markings=markings, warnings=tuple(warnings))
