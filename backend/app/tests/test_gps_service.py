from datetime import UTC, date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api.routes.time_entries import list_time_entries, time_entry_read
from app.core.geofence import DEFAULT_SITE_GEOFENCE_RADIUS_M
from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import GpsSourceType, SiteStatus, UserRole
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.gps import GpsLocationPointCreate
from app.services.geo_service import is_point_inside_site_geofence
from app.services.gps_service import (
    NOTICE_GPS_DIFFERS_FROM_PLAN,
    NOTICE_GPS_NOT_CHECKABLE,
    NOTICE_MANUAL_DIFFERS_FROM_GPS,
    NOTICE_MANUAL_DIFFERS_FROM_PLAN,
    GpsPresenceService,
)


BERLIN = ZoneInfo("Europe/Berlin")


def service() -> GpsPresenceService:
    item = GpsPresenceService.__new__(GpsPresenceService)
    item.db = SimpleNamespace()
    return item


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_monteur_cannot_send_gps_point_for_other_person():
    current_user = SimpleNamespace(role=UserRole.MONTEUR, person_id=5)

    with pytest.raises(HTTPException) as error:
        service()._effective_person_id(current_user, 6)

    assert error.value.status_code == 403


def test_admin_can_send_test_gps_point_for_person():
    current_user = SimpleNamespace(role=UserRole.ADMIN, person_id=None)

    assert service()._effective_person_id(current_user, 6) == 6


def test_gps_point_rejects_invalid_coordinates():
    with pytest.raises(ValidationError):
        GpsLocationPointCreate(
            person_id=1,
            captured_at=datetime.now(UTC),
            latitude=120,
            longitude=9.0263,
        )


@pytest.mark.parametrize(
    ("captured_at", "should_accept"),
    [
        (datetime(2026, 6, 10, 4, 59, tzinfo=BERLIN), False),
        (datetime(2026, 6, 10, 5, 0, tzinfo=BERLIN), True),
        (datetime(2026, 6, 10, 18, 59, tzinfo=BERLIN), True),
        (datetime(2026, 6, 10, 19, 0, tzinfo=BERLIN), False),
    ],
)
def test_gps_location_point_is_saved_only_inside_allowed_berlin_window(captured_at: datetime, should_accept: bool):
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    db.add(person)
    db.commit()
    current_user = SimpleNamespace(id=7, role=UserRole.MONTEUR, person_id=person.id)
    payload = GpsLocationPointCreate(
        captured_at=captured_at.astimezone(UTC),
        latitude=53.0142,
        longitude=9.0263,
    )

    if should_accept:
        point = GpsPresenceService(db).create_location_point(payload, current_user)
        assert point.id is not None
        assert list(db.scalars(select(GpsPoint))) == [point]
    else:
        with pytest.raises(HTTPException) as error:
            GpsPresenceService(db).create_location_point(payload, current_user)
        assert error.value.status_code == 422
        assert list(db.scalars(select(GpsPoint))) == []


def test_evaluate_presence_ignores_gps_points_outside_allowed_window():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
        status=SiteStatus.ACTIVE,
    )
    db.add_all([person, site])
    db.commit()
    db.add_all([
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 10, 4, 59, tzinfo=BERLIN).astimezone(UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 10, 5, 0, tzinfo=BERLIN).astimezone(UTC),
        ),
    ])
    db.commit()

    result = GpsPresenceService(db).evaluate_presence(
        person_id=person.id,
        site_id=site.id,
        start_datetime=datetime(2026, 6, 10, 0, 0, tzinfo=UTC),
        end_datetime=datetime(2026, 6, 10, 23, 59, tzinfo=UTC),
    )

    assert result.status == "matched"
    assert result.total_points == 1
    assert result.matched_points == 1


def test_presence_status_for_missing_points():
    assert service()._presence_status(total_points=0, matched_points=0) == "missing"


def test_presence_status_for_all_points_inside_radius():
    assert service()._presence_status(total_points=1, matched_points=1) == "matched"


def test_presence_status_for_mixed_points():
    assert service()._presence_status(total_points=3, matched_points=1) == "partial"


def test_presence_status_for_points_outside_radius():
    assert service()._presence_status(total_points=3, matched_points=0) == "mismatch"


def test_point_plausibility_matches_inside_planned_site():
    point = SimpleNamespace(latitude=53.0142, longitude=9.0263)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "matched"
    assert result.planned_site_label == "8007 - Klinik"
    assert result.distance_to_planned_site_m == pytest.approx(0)


def test_point_plausibility_flags_outside_planned_site():
    point = SimpleNamespace(latitude=53.8, longitude=10.1)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "mismatch"
    assert result.distance_to_planned_site_m is not None


def test_point_plausibility_without_geofence_is_not_checkable():
    point = SimpleNamespace(latitude=53.0142, longitude=9.0263)
    site = SimpleNamespace(
        id=7,
        site_number="8007",
        name="Klinik",
        latitude=None,
        longitude=None,
        geofence_radius_m=5000,
    )

    result = service()._evaluate_point_against_planned_sites(point, [site])

    assert result.plausibility_status == "not_checkable"
    assert result.distance_to_planned_site_m is None


def test_default_site_geofence_radius_is_3000_meters():
    point = SimpleNamespace(latitude=52.0, longitude=8.0)
    site = SimpleNamespace(latitude=52.0, longitude=8.0, geofence_radius_m=None)

    result = is_point_inside_site_geofence(point, site)

    assert DEFAULT_SITE_GEOFENCE_RADIUS_M == 3000
    assert result.radius_m == 3000


def test_gps_stay_prefers_planned_site_when_multiple_sites_match():
    db = db_session()
    work_date = date(2026, 6, 4)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    active_site = Site(
        site_number="1001",
        name="Aktiv näher",
        latitude=52.0002,
        longitude=8.0002,
        geofence_radius_m=3000,
        status=SiteStatus.ACTIVE,
    )
    planned_site = Site(
        site_number="1002",
        name="Geplant weiter",
        latitude=52.005,
        longitude=8.005,
        geofence_radius_m=3000,
        status=SiteStatus.PLANNED,
    )
    db.add_all([person, active_site, planned_site])
    db.commit()

    db.add(Assignment(
        person_id=person.id,
        site_id=planned_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    db.add_all([
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 4, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 4, 9, 0, tzinfo=UTC),
        ),
    ])
    db.commit()

    stays = GpsPresenceService(db).list_site_stays_for_review(date_from=work_date, date_to=work_date)

    assert len(stays) == 1
    assert stays[0].site_id == planned_site.id


def test_gps_stay_ignores_inactive_unplanned_site_but_allows_inactive_planned_site():
    db = db_session()
    work_date = date(2026, 6, 5)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    completed_site = Site(
        site_number="9001",
        name="Abgeschlossen geplant",
        latitude=52.0,
        longitude=8.0,
        geofence_radius_m=3000,
        status=SiteStatus.COMPLETED,
    )
    db.add_all([person, completed_site])
    db.commit()

    db.add_all([
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 5, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 5, 9, 0, tzinfo=UTC),
        ),
    ])
    db.commit()

    service = GpsPresenceService(db)

    assert service.list_site_stays_for_review(date_from=work_date, date_to=work_date) == []

    db.add(Assignment(
        person_id=person.id,
        site_id=completed_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    db.commit()

    stays = service.list_site_stays_for_review(date_from=work_date, date_to=work_date)

    assert len(stays) == 1
    assert stays[0].site_id == completed_site.id


def test_gps_stay_uses_nearest_active_site_when_no_planned_site_matches():
    db = db_session()
    work_date = date(2026, 6, 6)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    near_site = Site(
        site_number="7001",
        name="Näher aktiv",
        latitude=52.0002,
        longitude=8.0002,
        geofence_radius_m=3000,
        status=SiteStatus.ACTIVE,
    )
    far_site = Site(
        site_number="7002",
        name="Weiter aktiv",
        latitude=52.005,
        longitude=8.005,
        geofence_radius_m=3000,
        status=SiteStatus.ACTIVE,
    )
    db.add_all([person, near_site, far_site])
    db.commit()

    db.add_all([
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 6, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.0,
            longitude=8.0,
            timestamp=datetime(2026, 6, 6, 9, 0, tzinfo=UTC),
        ),
    ])
    db.commit()

    stays = GpsPresenceService(db).list_site_stays_for_review(date_from=work_date, date_to=work_date)

    assert len(stays) == 1
    assert stays[0].site_id == near_site.id


def matrix_manual_gps_review_response(
    *,
    planned_site_keys: tuple[str, ...],
    manual_site_key: str,
    gps_site_key: str | None,
):
    db = db_session()
    work_date = date(2026, 6, 7)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    sites = {
        "A": Site(
            site_number="A",
            name="Baustelle A",
            latitude=52.0,
            longitude=8.0,
            geofence_radius_m=800,
            status=SiteStatus.ACTIVE,
        ),
        "B": Site(
            site_number="B",
            name="Baustelle B",
            latitude=53.0,
            longitude=9.0,
            geofence_radius_m=800,
            status=SiteStatus.ACTIVE,
        ),
    }
    db.add(person)
    db.add_all(sites.values())
    db.commit()

    db.add_all([
        Assignment(
            person_id=person.id,
            site_id=sites[site_key].id,
            start_date=work_date,
            end_date=work_date,
        )
        for site_key in planned_site_keys
    ])
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=sites[manual_site_key].id,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    db.add(entry)
    if gps_site_key is not None:
        gps_site = sites[gps_site_key]
        db.add_all([
            GpsPoint(
                source_type=GpsSourceType.PHONE,
                source_id="mobile:test",
                person_id=person.id,
                latitude=gps_site.latitude,
                longitude=gps_site.longitude,
                timestamp=datetime(2026, 6, 7, 8, 0, tzinfo=UTC),
            ),
            GpsPoint(
                source_type=GpsSourceType.PHONE,
                source_id="mobile:test",
                person_id=person.id,
                latitude=gps_site.latitude,
                longitude=gps_site.longitude,
                timestamp=datetime(2026, 6, 7, 16, 0, tzinfo=UTC),
            ),
        ])
    db.commit()

    all_entries = list_time_entries(
        date_from=work_date,
        date_to=work_date,
        include_gps_status=True,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
        db=db,
    )
    open_entries = list_time_entries(
        date_from=work_date,
        date_to=work_date,
        include_gps_status=True,
        review_open_only=True,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
        db=db,
    )
    return all_entries[0], open_entries


def test_matrix_manual_gps_all_match_is_plausible():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A",),
        manual_site_key="A",
        gps_site_key="A",
    )

    assert response.review_notices == []
    assert response.planned_vs_gps_mismatch is False
    assert response.manual_vs_planned_mismatch is False
    assert response.manual_vs_gps_mismatch is False
    assert open_entries == []


def test_matrix_manual_match_but_gps_differs_from_both_sources():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A",),
        manual_site_key="A",
        gps_site_key="B",
    )

    assert response.planned_vs_gps_mismatch is True
    assert response.manual_vs_gps_mismatch is True
    assert response.manual_vs_planned_mismatch is False
    assert NOTICE_GPS_DIFFERS_FROM_PLAN in response.review_notices
    assert NOTICE_MANUAL_DIFFERS_FROM_GPS in response.review_notices
    assert any(entry.id == response.id for entry in open_entries)


def test_manual_and_gps_match_but_both_differ_from_matrix():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A",),
        manual_site_key="B",
        gps_site_key="B",
    )

    assert response.planned_vs_gps_mismatch is True
    assert response.manual_vs_gps_mismatch is False
    assert response.manual_vs_planned_mismatch is True
    assert NOTICE_GPS_DIFFERS_FROM_PLAN in response.review_notices
    assert NOTICE_MANUAL_DIFFERS_FROM_PLAN in response.review_notices
    assert len(open_entries) == 1


def test_manual_differs_from_matrix_and_gps_when_gps_matches_matrix():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A",),
        manual_site_key="B",
        gps_site_key="A",
    )

    assert response.planned_vs_gps_mismatch is False
    assert response.manual_vs_gps_mismatch is True
    assert response.manual_vs_planned_mismatch is True
    assert NOTICE_GPS_DIFFERS_FROM_PLAN not in response.review_notices
    assert NOTICE_MANUAL_DIFFERS_FROM_GPS in response.review_notices
    assert NOTICE_MANUAL_DIFFERS_FROM_PLAN in response.review_notices
    assert any(entry.id == response.id for entry in open_entries)


def test_multiple_planned_sites_do_not_flag_matrix_gps_conflict_when_gps_matches_one():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A", "B"),
        manual_site_key="A",
        gps_site_key="B",
    )

    assert response.planned_vs_gps_mismatch is False
    assert response.manual_vs_gps_mismatch is True
    assert response.manual_vs_planned_mismatch is False
    assert NOTICE_GPS_DIFFERS_FROM_PLAN not in response.review_notices
    assert NOTICE_MANUAL_DIFFERS_FROM_GPS in response.review_notices
    assert any(entry.id == response.id for entry in open_entries)


def test_gps_not_checkable_adds_notice_without_source_mismatch():
    response, open_entries = matrix_manual_gps_review_response(
        planned_site_keys=("A",),
        manual_site_key="A",
        gps_site_key=None,
    )

    assert response.planned_vs_gps_mismatch is False
    assert response.manual_vs_gps_mismatch is False
    assert response.manual_vs_planned_mismatch is False
    assert response.gps_not_checkable is True
    assert response.review_notices == [NOTICE_GPS_NOT_CHECKABLE]
    assert len(open_entries) == 1


def test_time_entry_response_uses_site_contact_range_for_gps_work_time():
    db = db_session()
    work_date = date(2026, 6, 1)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    planned_site = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )
    db.add_all([person, planned_site])
    db.commit()

    db.add(Assignment(
        person_id=person.id,
        site_id=planned_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=None,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    older_outside_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.8,
        longitude=10.1,
        timestamp=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
    )
    first_inside_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.0142,
        longitude=9.0263,
        timestamp=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
    )
    latest_inside_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.0142,
        longitude=9.0263,
        timestamp=datetime(2026, 6, 1, 13, 0, tzinfo=UTC),
    )
    db.add_all([entry, older_outside_point, first_inside_point, latest_inside_point])
    db.commit()

    response = time_entry_read(entry, gps_service=GpsPresenceService(db))

    assert response.gps_status == "matched"
    assert response.gps_matched_points == 1
    assert response.gps_total_points == 1
    assert response.gps_first_seen_at == first_inside_point.timestamp
    assert response.gps_last_seen_at == latest_inside_point.timestamp
    assert response.gps_work_minutes == 60
    assert response.planned_site_labels == ["8007 - Klinik"]
    assert response.gps_detected_site_id == planned_site.id
    assert response.planned_vs_gps_mismatch is False
    assert response.mismatch_notice is None


def test_time_entry_response_uses_first_and_last_site_contact_across_multiple_sites():
    db = db_session()
    work_date = date(2026, 6, 8)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    first_site = Site(
        site_number="A",
        name="Baustelle A",
        latitude=52.0,
        longitude=8.0,
        geofence_radius_m=800,
        status=SiteStatus.ACTIVE,
    )
    second_site = Site(
        site_number="B",
        name="Baustelle B",
        latitude=53.0,
        longitude=9.0,
        geofence_radius_m=800,
        status=SiteStatus.ACTIVE,
    )
    db.add_all([person, first_site, second_site])
    db.commit()

    db.add_all([
        Assignment(person_id=person.id, site_id=first_site.id, start_date=work_date, end_date=work_date),
        Assignment(person_id=person.id, site_id=second_site.id, start_date=work_date, end_date=work_date),
    ])
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=first_site.id,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    early_tracking_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=51.0,
        longitude=7.0,
        timestamp=datetime(2026, 6, 8, 5, 30, tzinfo=UTC),
    )
    first_site_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=52.0,
        longitude=8.0,
        timestamp=datetime(2026, 6, 8, 6, 0, tzinfo=UTC),
    )
    transfer_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=52.5,
        longitude=8.5,
        timestamp=datetime(2026, 6, 8, 10, 0, tzinfo=UTC),
    )
    last_site_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=53.0,
        longitude=9.0,
        timestamp=datetime(2026, 6, 8, 16, 12, tzinfo=UTC),
    )
    late_tracking_point = GpsPoint(
        source_type=GpsSourceType.PHONE,
        source_id="mobile:test",
        person_id=person.id,
        latitude=51.0,
        longitude=7.0,
        timestamp=datetime(2026, 6, 8, 18, 55, tzinfo=UTC),
    )
    db.add_all([entry, early_tracking_point, first_site_point, transfer_point, last_site_point, late_tracking_point])
    db.commit()

    response = time_entry_read(entry, gps_service=GpsPresenceService(db))

    assert response.gps_first_seen_at == first_site_point.timestamp
    assert response.gps_last_seen_at == last_site_point.timestamp
    assert response.gps_work_minutes == 612


def test_time_entry_response_has_no_gps_work_time_without_site_contact():
    db = db_session()
    work_date = date(2026, 6, 9)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    planned_site = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
    )
    db.add_all([person, planned_site])
    db.commit()

    db.add(Assignment(
        person_id=person.id,
        site_id=planned_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=planned_site.id,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    db.add_all([
        entry,
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.8,
            longitude=10.1,
            timestamp=datetime(2026, 6, 9, 5, 13, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.9,
            longitude=10.2,
            timestamp=datetime(2026, 6, 9, 18, 55, tzinfo=UTC),
        ),
    ])
    db.commit()

    response = time_entry_read(entry, gps_service=GpsPresenceService(db))

    assert response.gps_status == "not_checkable"
    assert response.gps_first_seen_at is None
    assert response.gps_last_seen_at is None
    assert response.gps_work_minutes is None


def test_review_response_flags_planned_site_gps_mismatch():
    db = db_session()
    work_date = date(2026, 6, 3)
    person = Person(
        first_name="Marcin",
        last_name="Monteur",
        display_name="Marcin Monteur",
        short_code="MM",
    )
    planned_site = Site(
        site_number="8008",
        name="Friedensschule Osnabrück",
        latitude=52.2799,
        longitude=8.0472,
        geofence_radius_m=800,
    )
    detected_site = Site(
        site_number="1010",
        name="Firma BEG",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=800,
    )
    db.add_all([person, planned_site, detected_site])
    db.commit()

    db.add(Assignment(
        person_id=person.id,
        site_id=planned_site.id,
        start_date=work_date,
        end_date=work_date,
    ))
    entry = WorkTimeEntry(
        person_id=person.id,
        site_id=planned_site.id,
        work_date=work_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    db.add(entry)
    db.add_all([
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 3, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 3, 16, 0, tzinfo=UTC),
        ),
    ])
    db.commit()

    response = list_time_entries(
        date_from=work_date,
        date_to=work_date,
        include_gps_status=True,
        review_open_only=True,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
        db=db,
    )

    manual_response = next(item for item in response if item.id == entry.id)
    assert manual_response.gps_work_minutes == 480
    assert manual_response.gps_status == "mismatch"
    assert manual_response.planned_site_labels == ["8008 - Friedensschule Osnabrück"]
    assert manual_response.gps_detected_site_id == detected_site.id
    assert manual_response.gps_detected_site_name == "Firma BEG"
    assert manual_response.planned_vs_gps_mismatch is True
    assert manual_response.mismatch_notice == "Geplant: 8008 - Friedensschule Osnabrück · GPS: 1010 - Firma BEG"


def test_review_response_adds_gps_suggestion_for_unreported_site_only():
    db = db_session()
    work_date = date(2026, 6, 2)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site_a = Site(
        site_number="8007",
        name="Klinik",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=800,
    )
    site_b = Site(
        site_number="8010",
        name="Schule",
        latitude=52.2799,
        longitude=8.0472,
        geofence_radius_m=800,
    )
    db.add_all([person, site_a, site_b])
    db.commit()

    manual_entry = WorkTimeEntry(
        person_id=person.id,
        site_id=site_a.id,
        work_date=work_date,
        work_minutes=240,
        break_minutes=0,
        travel_minutes=0,
        source="manual",
        status="draft",
    )
    gps_points = [
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 2, 8, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=53.0142,
            longitude=9.0263,
            timestamp=datetime(2026, 6, 2, 12, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.2799,
            longitude=8.0472,
            timestamp=datetime(2026, 6, 2, 13, 0, tzinfo=UTC),
        ),
        GpsPoint(
            source_type=GpsSourceType.PHONE,
            source_id="mobile:test",
            person_id=person.id,
            latitude=52.2799,
            longitude=8.0472,
            timestamp=datetime(2026, 6, 2, 16, 0, tzinfo=UTC),
        ),
    ]
    db.add(manual_entry)
    db.add_all(gps_points)
    db.commit()

    response = list_time_entries(
        date_from=work_date,
        date_to=work_date,
        include_gps_status=True,
        review_open_only=True,
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None),
        db=db,
    )

    gps_suggestions = [entry for entry in response if entry.is_gps_suggestion]
    assert len(gps_suggestions) == 1
    assert gps_suggestions[0].site_id == site_b.id
    assert gps_suggestions[0].gps_work_minutes == 180
    assert gps_suggestions[0].work_minutes == 0
    assert gps_suggestions[0].source == "gps_suggestion"
    assert not any(entry.is_gps_suggestion and entry.site_id == site_a.id for entry in response)
