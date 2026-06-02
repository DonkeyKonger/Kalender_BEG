from __future__ import annotations

import argparse
import json
import math
import os
import random
import string
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import (
    AbsenceStatus,
    AbsenceType,
    AssignmentType,
    GpsSourceType,
    PersonType,
    SiteLocationStatus,
    SiteStatus,
    UserRole,
)
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry


MARKER = "TEST_DATA_GENERATOR"
TEST_SOURCE = "test_generator"
DEFAULT_ERROR_RATE = 0.30
DEFAULT_PERSON_LIMIT = 8
DEFAULT_SITE_LIMIT = 6
MIN_PERSON_COUNT = 4
MIN_COORD_SITE_COUNT = 5
GPS_INTERVAL_MINUTES = 15
MAX_QUEUE_LIKE_POINTS_PER_DAY = 60


@dataclass(frozen=True)
class GeneratorOptions:
    start_date: date
    end_date: date
    person_count: int | None
    site_count: int | None
    error_rate: float
    seed: int
    clear_previous_test_data: bool


@dataclass
class GeneratorSummary:
    batch_id: str
    start_date: str
    end_date: str
    random_seed: int
    people_used: int = 0
    sites_used: int = 0
    assignments_created: int = 0
    work_time_entries_created: int = 0
    gps_points_created: int = 0
    absences_created: int = 0
    created_test_people: int = 0
    created_test_sites: int = 0
    scenarios: dict[str, int] = field(default_factory=dict)
    expected_open_review_cases: int = 0
    expected_checked_cases: int = 0
    cleared_previous_rows: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ScenarioContext:
    person: Person
    work_date: date
    scenario: str
    site_index: int


GERMAN_COORDINATES = [
    ("Bremen Mitte", 53.0793, 8.8017),
    ("Hamburg Hammerbrook", 53.5451, 10.0304),
    ("Hannover List", 52.3891, 9.7546),
    ("Oldenburg Hafen", 53.1435, 8.2146),
    ("Verden Aller", 52.9234, 9.2349),
    ("Rotenburg Wuemme", 53.1086, 9.3970),
    ("Osnabrueck Hafen", 52.2799, 8.0472),
    ("Bremerhaven Geeste", 53.5396, 8.5809),
]

TEST_PERSON_NAMES = [
    ("Marcin", "Cholewka"),
    ("Pawel", "Kolodziejczyk"),
    ("Christopher", "Erichsen"),
    ("Anna", "Nowak"),
    ("Marek", "Zielinski"),
    ("Tomasz", "Lewandowski"),
    ("Piotr", "Kaminski"),
    ("Ewa", "Witkowska"),
]

REQUIRED_SCENARIOS = [
    "plausible_normal",
    "small_deviation",
    "review_recommended",
    "critical_deviation",
    "missing_gps",
    "partial_gps",
    "outside_geofence",
    "wrong_site",
    "two_sites",
    "weekend_work",
    "absence_conflict",
    "site_without_coordinates",
    "poor_accuracy",
    "offline_resync",
    "new_device",
    "extreme_hours",
    "already_reviewed",
]

OPEN_REVIEW_SCENARIOS = {
    "review_recommended",
    "critical_deviation",
    "missing_gps",
    "partial_gps",
    "outside_geofence",
    "wrong_site",
    "two_sites",
    "weekend_work",
    "absence_conflict",
    "site_without_coordinates",
    "poor_accuracy",
    "offline_resync",
    "new_device",
    "extreme_hours",
}

PLAUSIBLE_SCENARIOS = ["plausible_normal", "small_deviation"]
ERROR_SCENARIOS = [scenario for scenario in REQUIRED_SCENARIOS if scenario not in PLAUSIBLE_SCENARIOS]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate realistic time/GPS review test data for development and staging."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate", help="Create a marked test-data batch.")
    generate_parser.add_argument("--start-date", type=parse_date)
    generate_parser.add_argument("--end-date", type=parse_date)
    generate_parser.add_argument("--person-count", type=positive_int)
    generate_parser.add_argument("--site-count", type=positive_int)
    generate_parser.add_argument("--error-rate", type=float, default=DEFAULT_ERROR_RATE)
    generate_parser.add_argument("--seed", type=int)
    generate_parser.add_argument("--clear-previous-test-data", action="store_true")

    clear_parser = subparsers.add_parser("clear", help="Delete a marked test-data batch.")
    clear_group = clear_parser.add_mutually_exclusive_group(required=True)
    clear_group.add_argument("--batch-id")
    clear_group.add_argument("--all-test-data", action="store_true")

    args = parser.parse_args()
    ensure_safe_environment()

    if args.command == "generate":
        start_date, end_date = resolve_date_range(args.start_date, args.end_date)
        if args.error_rate < 0 or args.error_rate > 1:
            raise SystemExit("--error-rate must be between 0 and 1.")
        options = GeneratorOptions(
            start_date=start_date,
            end_date=end_date,
            person_count=args.person_count,
            site_count=args.site_count,
            error_rate=args.error_rate,
            seed=args.seed if args.seed is not None else random.SystemRandom().randint(1, 999_999_999),
            clear_previous_test_data=args.clear_previous_test_data,
        )
        summary = generate_time_gps_test_data(options)
        print_summary(summary)
        return

    if args.command == "clear":
        with SessionLocal() as db:
            if args.all_test_data:
                result = clear_test_data(db, batch_id=None)
            else:
                result = clear_test_data(db, batch_id=args.batch_id)
            db.commit()
        print(json.dumps({"deleted_rows": result}, indent=2, sort_keys=True))


def generate_time_gps_test_data(options: GeneratorOptions) -> GeneratorSummary:
    rng = random.Random(options.seed)
    batch_id = new_batch_id(rng)
    summary = GeneratorSummary(
        batch_id=batch_id,
        start_date=options.start_date.isoformat(),
        end_date=options.end_date.isoformat(),
        random_seed=options.seed,
    )

    with SessionLocal() as db:
        if options.clear_previous_test_data:
            summary.cleared_previous_rows = clear_test_data(db, batch_id=None)
            db.flush()

        actor_user_id = find_actor_user_id(db)
        people = select_or_create_people(db, options, batch_id, rng, summary)
        coord_sites = select_or_create_coordinate_sites(db, options, batch_id, rng, summary)
        no_coord_site = select_or_create_no_coordinate_site(db, batch_id, rng, summary)
        all_sites = coord_sites + [no_coord_site]

        summary.people_used = len(people)
        summary.sites_used = len(all_sites)

        dates = date_range(options.start_date, options.end_date)
        scenarios = build_scenario_plan(people, dates, options, rng)
        scenario_counter: Counter[str] = Counter()

        for index, context in enumerate(scenarios):
            scenario_counter[context.scenario] += 1
            create_scenario(
                db=db,
                context=context,
                coord_sites=coord_sites,
                no_coord_site=no_coord_site,
                batch_id=batch_id,
                rng=rng,
                actor_user_id=actor_user_id,
                summary=summary,
                scenario_index=index,
            )

        summary.scenarios = dict(sorted(scenario_counter.items()))
        summary.expected_open_review_cases = sum(
            count for scenario, count in scenario_counter.items() if scenario in OPEN_REVIEW_SCENARIOS
        )
        summary.expected_checked_cases = scenario_counter.get("already_reviewed", 0)
        db.commit()

    return summary


def ensure_safe_environment() -> None:
    environment = (settings.environment or "").strip().lower()
    test_mode = truthy(os.getenv("TEST_MODE"))
    if environment == "production" and not test_mode:
        raise SystemExit(
            "Refusing to run in production. Set TEST_MODE=true only for an explicitly approved test run."
        )


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected date format YYYY-MM-DD.") from exc


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("Expected a positive integer.")
    return parsed


def resolve_date_range(start_date: date | None, end_date: date | None) -> tuple[date, date]:
    if start_date is None and end_date is None:
        today = date.today()
        start_date = today - timedelta(days=today.weekday())
        end_date = start_date + timedelta(days=6)
    elif start_date is None:
        start_date = end_date
    elif end_date is None:
        end_date = start_date

    if start_date is None or end_date is None:
        raise SystemExit("Could not resolve date range.")
    if end_date < start_date:
        raise SystemExit("--end-date must not be before --start-date.")
    return start_date, end_date


def new_batch_id(rng: random.Random) -> str:
    suffix = "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    return f"timegps-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{suffix}"


def marker_note(batch_id: str, scenario: str, extra: str | None = None) -> str:
    base = f"{MARKER} batch_id={batch_id} scenario={scenario}"
    return f"{base} {extra}" if extra else base


def find_actor_user_id(db: Session) -> int | None:
    preferred_roles = [UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE]
    for role in preferred_roles:
        user_id = db.scalar(select(User.id).where(User.role == role, User.is_active.is_(True)).order_by(User.id))
        if user_id is not None:
            return user_id
    return db.scalar(select(User.id).where(User.is_active.is_(True)).order_by(User.id))


def select_or_create_people(
    db: Session,
    options: GeneratorOptions,
    batch_id: str,
    rng: random.Random,
    summary: GeneratorSummary,
) -> list[Person]:
    existing = list(
        db.scalars(
            select(Person)
            .where(
                Person.is_active.is_(True),
                Person.person_type.in_([PersonType.INTERNAL, PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP]),
            )
            .order_by(Person.last_name, Person.first_name, Person.id)
        )
    )
    target = options.person_count or min(max(len(existing), MIN_PERSON_COUNT), DEFAULT_PERSON_LIMIT)
    people = existing[:target]
    for index in range(max(0, target - len(people))):
        first_name, last_name = TEST_PERSON_NAMES[(len(people) + index) % len(TEST_PERSON_NAMES)]
        suffix = f"{batch_id[-6:]}{index + 1}"
        person = Person(
            first_name=first_name,
            last_name=last_name,
            display_name=f"{first_name} {last_name}",
            short_code=f"TGPS{suffix}".upper()[:30],
            person_type=PersonType.INTERNAL,
            is_active=True,
            company_phone_device_id=f"test_device:{batch_id}:{index + 1}",
            notes=marker_note(batch_id, "test_person"),
        )
        db.add(person)
        db.flush()
        people.append(person)
        summary.created_test_people += 1
    return people


def select_or_create_coordinate_sites(
    db: Session,
    options: GeneratorOptions,
    batch_id: str,
    rng: random.Random,
    summary: GeneratorSummary,
) -> list[Site]:
    existing = list(
        db.scalars(
            select(Site)
            .where(
                Site.status.in_([SiteStatus.ACTIVE, SiteStatus.PLANNED]),
                Site.latitude.is_not(None),
                Site.longitude.is_not(None),
            )
            .order_by(Site.site_number, Site.name, Site.id)
        )
    )
    target = options.site_count or min(max(len(existing), MIN_COORD_SITE_COUNT), DEFAULT_SITE_LIMIT)
    sites = existing[:target]
    for index in range(max(0, target - len(sites))):
        name, lat, lon = GERMAN_COORDINATES[(len(sites) + index) % len(GERMAN_COORDINATES)]
        site_number = f"TEST-GPS-{batch_id[-6:].upper()}-{index + 1:02d}"
        site = Site(
            site_number=site_number,
            name=f"Testbaustelle {name}",
            location=name,
            address=f"{name}, Deutschland",
            city=name.split()[0],
            latitude=lat,
            longitude=lon,
            geofence_radius_m=5000,
            location_status=SiteLocationStatus.GEOCODED,
            status=SiteStatus.ACTIVE,
            info=marker_note(batch_id, "test_site", "with_coordinates"),
            planned_work_minutes=9600,
        )
        db.add(site)
        db.flush()
        sites.append(site)
        summary.created_test_sites += 1
    return sites


def select_or_create_no_coordinate_site(
    db: Session,
    batch_id: str,
    rng: random.Random,
    summary: GeneratorSummary,
) -> Site:
    existing = db.scalar(
        select(Site)
        .where(
            Site.status.in_([SiteStatus.ACTIVE, SiteStatus.PLANNED]),
            Site.latitude.is_(None),
            Site.longitude.is_(None),
        )
        .order_by(Site.id)
    )
    if existing is not None:
        return existing

    site = Site(
        site_number=f"TEST-GPS-{batch_id[-6:].upper()}-NOCOORD",
        name="Testbaustelle ohne Koordinaten",
        location="Adresse unklar",
        address="Adresse unklar",
        geofence_radius_m=5000,
        location_status=SiteLocationStatus.UNCHECKED,
        status=SiteStatus.ACTIVE,
        info=marker_note(batch_id, "test_site_without_coordinates"),
        planned_work_minutes=4800,
    )
    db.add(site)
    db.flush()
    summary.created_test_sites += 1
    return site


def date_range(start_date: date, end_date: date) -> list[date]:
    days = (end_date - start_date).days
    return [start_date + timedelta(days=offset) for offset in range(days + 1)]


def build_scenario_plan(
    people: list[Person],
    dates: list[date],
    options: GeneratorOptions,
    rng: random.Random,
) -> list[ScenarioContext]:
    slots = [(person, work_date) for work_date in dates for person in people]
    if not slots:
        return []

    weekend_dates = [work_date for work_date in dates if work_date.weekday() >= 5]
    contexts: list[ScenarioContext] = []
    for index, (person, work_date) in enumerate(slots):
        if index < len(REQUIRED_SCENARIOS):
            scenario = REQUIRED_SCENARIOS[index]
        elif rng.random() < options.error_rate:
            scenario = rng.choice(ERROR_SCENARIOS)
        else:
            scenario = rng.choice(PLAUSIBLE_SCENARIOS)

        scenario_date = work_date
        if scenario == "weekend_work" and weekend_dates:
            scenario_date = weekend_dates[index % len(weekend_dates)]

        contexts.append(
            ScenarioContext(
                person=person,
                work_date=scenario_date,
                scenario=scenario,
                site_index=index,
            )
        )
    return contexts


def create_scenario(
    *,
    db: Session,
    context: ScenarioContext,
    coord_sites: list[Site],
    no_coord_site: Site,
    batch_id: str,
    rng: random.Random,
    actor_user_id: int | None,
    summary: GeneratorSummary,
    scenario_index: int,
) -> None:
    site = coord_sites[context.site_index % len(coord_sites)]
    other_site = coord_sites[(context.site_index + 1) % len(coord_sites)]
    scenario = context.scenario

    if scenario == "plausible_normal":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=480
        )
    elif scenario == "small_deviation":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=470
        )
    elif scenario == "review_recommended":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=440
        )
    elif scenario == "critical_deviation":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=300
        )
    elif scenario == "missing_gps":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=None
        )
    elif scenario == "partial_gps":
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=180
        )
    elif scenario == "outside_geofence":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=300,
            gps_site=site,
            outside_geofence=True,
        )
    elif scenario == "wrong_site":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=330,
            gps_site=other_site,
        )
    elif scenario == "two_sites":
        create_two_site_day(db, context, site, other_site, batch_id, rng, actor_user_id, summary)
    elif scenario == "weekend_work":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=420,
            note_extra="weekend_hint",
        )
    elif scenario == "absence_conflict":
        create_absence(db, context, batch_id, rng, actor_user_id, summary)
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=360,
            note_extra="absence_conflict",
        )
    elif scenario == "site_without_coordinates":
        create_regular_day(
            db,
            context,
            no_coord_site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=None,
            note_extra="site_without_coordinates",
        )
    elif scenario == "poor_accuracy":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=360,
            accuracy_m=1500,
            note_extra="poor_accuracy",
        )
    elif scenario == "offline_resync":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=430,
            source_suffix="offline_resync",
            note_extra="offline_resync_original_timestamp_used",
        )
    elif scenario == "new_device":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=450,
            source_suffix=f"new_device_{scenario_index}",
            note_extra="new_device_id",
        )
    elif scenario == "extreme_hours":
        manual_minutes = rng.choice([0, 660, 720])
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=manual_minutes,
            gps_minutes=480,
            note_extra="extreme_manual_hours",
        )
    elif scenario == "already_reviewed":
        create_regular_day(
            db,
            context,
            site,
            batch_id,
            rng,
            actor_user_id,
            summary,
            manual_minutes=480,
            gps_minutes=300,
            review_status="manually_approved",
            review_method="accept_manual",
            status="reviewed",
            note_extra="already_reviewed",
        )
    else:
        create_regular_day(
            db, context, site, batch_id, rng, actor_user_id, summary, manual_minutes=480, gps_minutes=480
        )


def create_regular_day(
    db: Session,
    context: ScenarioContext,
    site: Site,
    batch_id: str,
    rng: random.Random,
    actor_user_id: int | None,
    summary: GeneratorSummary,
    *,
    manual_minutes: int,
    gps_minutes: int | None,
    gps_site: Site | None = None,
    outside_geofence: bool = False,
    accuracy_m: float | None = None,
    source_suffix: str | None = None,
    review_status: str = "open",
    review_method: str | None = None,
    status: str = "submitted",
    note_extra: str | None = None,
) -> None:
    assignment = create_assignment(db, context, site, batch_id, actor_user_id, summary)
    create_work_time_entry(
        db=db,
        context=context,
        site=site,
        assignment=assignment,
        batch_id=batch_id,
        actor_user_id=actor_user_id,
        summary=summary,
        manual_minutes=manual_minutes,
        review_status=review_status,
        review_method=review_method,
        status=status,
        note_extra=note_extra,
    )
    if gps_minutes is not None and gps_minutes > 0:
        create_gps_points(
            db=db,
            person=context.person,
            work_date=context.work_date,
            site=gps_site or site,
            batch_id=batch_id,
            scenario=context.scenario,
            rng=rng,
            summary=summary,
            gps_minutes=gps_minutes,
            outside_geofence=outside_geofence,
            accuracy_m=accuracy_m,
            source_suffix=source_suffix,
        )
    elif gps_minutes == 0:
        create_single_gps_point(
            db=db,
            person=context.person,
            work_date=context.work_date,
            site=gps_site or site,
            batch_id=batch_id,
            scenario=context.scenario,
            rng=rng,
            summary=summary,
            source_suffix=source_suffix,
        )


def create_two_site_day(
    db: Session,
    context: ScenarioContext,
    site_a: Site,
    site_b: Site,
    batch_id: str,
    rng: random.Random,
    actor_user_id: int | None,
    summary: GeneratorSummary,
) -> None:
    morning_context = ScenarioContext(context.person, context.work_date, context.scenario, context.site_index)
    afternoon_context = ScenarioContext(context.person, context.work_date, context.scenario, context.site_index + 1)
    assignment_a = create_assignment(db, morning_context, site_a, batch_id, actor_user_id, summary, "morning")
    assignment_b = create_assignment(db, afternoon_context, site_b, batch_id, actor_user_id, summary, "afternoon")
    create_work_time_entry(
        db=db,
        context=morning_context,
        site=site_a,
        assignment=assignment_a,
        batch_id=batch_id,
        actor_user_id=actor_user_id,
        summary=summary,
        manual_minutes=240,
        note_extra="two_sites_morning",
    )
    create_work_time_entry(
        db=db,
        context=afternoon_context,
        site=site_b,
        assignment=assignment_b,
        batch_id=batch_id,
        actor_user_id=actor_user_id,
        summary=summary,
        manual_minutes=240,
        note_extra="two_sites_afternoon",
    )
    create_gps_points(
        db=db,
        person=context.person,
        work_date=context.work_date,
        site=site_a,
        batch_id=batch_id,
        scenario=context.scenario,
        rng=rng,
        summary=summary,
        gps_minutes=240,
        start_hour=7,
        source_suffix="two_sites_morning",
    )
    create_gps_points(
        db=db,
        person=context.person,
        work_date=context.work_date,
        site=site_b,
        batch_id=batch_id,
        scenario=context.scenario,
        rng=rng,
        summary=summary,
        gps_minutes=240,
        start_hour=12,
        source_suffix="two_sites_afternoon",
    )


def create_assignment(
    db: Session,
    context: ScenarioContext,
    site: Site,
    batch_id: str,
    actor_user_id: int | None,
    summary: GeneratorSummary,
    extra: str | None = None,
) -> Assignment:
    assignment = Assignment(
        site_id=site.id,
        person_id=context.person.id,
        start_date=context.work_date,
        end_date=context.work_date,
        assignment_type=AssignmentType.REGULAR,
        note=marker_note(batch_id, context.scenario, extra),
        created_by_user_id=actor_user_id,
        updated_by_user_id=actor_user_id,
    )
    db.add(assignment)
    db.flush()
    summary.assignments_created += 1
    return assignment


def create_absence(
    db: Session,
    context: ScenarioContext,
    batch_id: str,
    rng: random.Random,
    actor_user_id: int | None,
    summary: GeneratorSummary,
) -> None:
    absence = Absence(
        person_id=context.person.id,
        absence_type=rng.choice([AbsenceType.VACATION, AbsenceType.SICK, AbsenceType.SCHOOL, AbsenceType.FREE]),
        start_date=context.work_date,
        end_date=context.work_date,
        status=AbsenceStatus.ACTIVE,
        note=marker_note(batch_id, context.scenario, "absence_conflict"),
        created_by_user_id=actor_user_id,
        updated_by_user_id=actor_user_id,
    )
    db.add(absence)
    db.flush()
    summary.absences_created += 1


def create_work_time_entry(
    *,
    db: Session,
    context: ScenarioContext,
    site: Site,
    assignment: Assignment,
    batch_id: str,
    actor_user_id: int | None,
    summary: GeneratorSummary,
    manual_minutes: int,
    review_status: str = "open",
    review_method: str | None = None,
    status: str = "submitted",
    note_extra: str | None = None,
) -> WorkTimeEntry:
    start = time(hour=7 + (context.site_index % 2), minute=30)
    end_dt = datetime.combine(context.work_date, start) + timedelta(minutes=max(manual_minutes, 0) + 30)
    entry = WorkTimeEntry(
        person_id=context.person.id,
        site_id=site.id,
        assignment_id=assignment.id,
        work_date=context.work_date,
        start_time=start,
        end_time=end_dt.time(),
        break_minutes=30 if manual_minutes >= 240 else 0,
        travel_minutes=30 if manual_minutes > 0 else 0,
        work_minutes=manual_minutes,
        original_work_minutes=manual_minutes if review_status != "open" else None,
        corrected_work_minutes=None,
        note=marker_note(batch_id, context.scenario, note_extra),
        source=TEST_SOURCE,
        status=status,
        time_review_status=review_status,
        time_review_method=review_method,
        created_by_user_id=actor_user_id,
        reviewed_by_user_id=actor_user_id if review_status != "open" else None,
        reviewed_at=datetime.now(UTC) if review_status != "open" else None,
    )
    db.add(entry)
    db.flush()
    summary.work_time_entries_created += 1
    return entry


def create_gps_points(
    *,
    db: Session,
    person: Person,
    work_date: date,
    site: Site,
    batch_id: str,
    scenario: str,
    rng: random.Random,
    summary: GeneratorSummary,
    gps_minutes: int,
    start_hour: int = 7,
    outside_geofence: bool = False,
    accuracy_m: float | None = None,
    source_suffix: str | None = None,
) -> None:
    if site.latitude is None or site.longitude is None:
        return

    point_count = max(2, min(MAX_QUEUE_LIKE_POINTS_PER_DAY, gps_minutes // GPS_INTERVAL_MINUTES + 1))
    start_at = datetime.combine(work_date, time(hour=start_hour, minute=rng.choice([0, 15, 30])), tzinfo=UTC)
    source_id = gps_source_id(batch_id, person.id, scenario, source_suffix)
    for index in range(point_count):
        if index == point_count - 1:
            timestamp = start_at + timedelta(minutes=gps_minutes)
        else:
            timestamp = start_at + timedelta(minutes=index * GPS_INTERVAL_MINUTES)
        latitude, longitude = gps_location_for_site(site, rng, outside_geofence=outside_geofence)
        db.add(
            GpsPoint(
                source_type=GpsSourceType.PHONE,
                source_id=source_id,
                person_id=person.id,
                latitude=latitude,
                longitude=longitude,
                timestamp=timestamp,
                accuracy_m=accuracy_m if accuracy_m is not None else rng.choice([8.0, 12.0, 18.0, 25.0, 35.0]),
            )
        )
        summary.gps_points_created += 1
    db.flush()


def create_single_gps_point(
    *,
    db: Session,
    person: Person,
    work_date: date,
    site: Site,
    batch_id: str,
    scenario: str,
    rng: random.Random,
    summary: GeneratorSummary,
    source_suffix: str | None = None,
) -> None:
    if site.latitude is None or site.longitude is None:
        return
    latitude, longitude = gps_location_for_site(site, rng, outside_geofence=False)
    db.add(
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id=gps_source_id(batch_id, person.id, scenario, source_suffix),
            person_id=person.id,
            latitude=latitude,
            longitude=longitude,
            timestamp=datetime.combine(work_date, time(hour=9, minute=0), tzinfo=UTC),
            accuracy_m=20.0,
        )
    )
    db.flush()
    summary.gps_points_created += 1


def gps_source_id(batch_id: str, person_id: int, scenario: str, suffix: str | None = None) -> str:
    raw = f"test_generator:{batch_id}:person:{person_id}:scenario:{scenario}"
    if suffix:
        raw = f"{raw}:{suffix}"
    return raw[:120]


def gps_location_for_site(site: Site, rng: random.Random, *, outside_geofence: bool) -> tuple[float, float]:
    if site.latitude is None or site.longitude is None:
        raise ValueError("Site needs coordinates for GPS test points.")
    radius = float(site.geofence_radius_m or 5000)
    if outside_geofence:
        distance_m = radius + rng.uniform(8_000, 18_000)
    else:
        distance_m = rng.uniform(10, min(radius * 0.35, 250))
    angle = rng.uniform(0, math.tau)
    return offset_coordinate(site.latitude, site.longitude, distance_m, angle)


def offset_coordinate(latitude: float, longitude: float, distance_m: float, angle_rad: float) -> tuple[float, float]:
    lat_offset = math.cos(angle_rad) * distance_m / 111_320
    lon_scale = max(0.1, math.cos(math.radians(latitude)))
    lon_offset = math.sin(angle_rad) * distance_m / (111_320 * lon_scale)
    return latitude + lat_offset, longitude + lon_offset


def clear_test_data(db: Session, *, batch_id: str | None) -> dict[str, int]:
    batch_filter = f"%batch_id={batch_id}%" if batch_id else f"%{MARKER}%"
    source_filter = f"test_generator:{batch_id}:%" if batch_id else "test_generator:%"

    deleted: dict[str, int] = {}
    deleted["gps_points"] = execute_delete(
        db,
        delete(GpsPoint).where(
            GpsPoint.source_type == GpsSourceType.PHONE,
            GpsPoint.source_id.like(source_filter),
        ),
    )
    deleted["work_time_entries"] = execute_delete(
        db,
        delete(WorkTimeEntry).where(
            WorkTimeEntry.source == TEST_SOURCE,
            WorkTimeEntry.note.like(batch_filter),
        ),
    )
    deleted["absences"] = execute_delete(db, delete(Absence).where(Absence.note.like(batch_filter)))
    deleted["assignments"] = execute_delete(db, delete(Assignment).where(Assignment.note.like(batch_filter)))
    deleted["sites"] = execute_delete(db, delete(Site).where(Site.info.like(batch_filter)))
    deleted["persons"] = execute_delete(db, delete(Person).where(Person.notes.like(batch_filter)))
    return deleted


def execute_delete(db: Session, statement: Any) -> int:
    result = db.execute(statement.execution_options(synchronize_session=False))
    return int(result.rowcount or 0)


def print_summary(summary: GeneratorSummary) -> None:
    print(json.dumps(asdict(summary), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
