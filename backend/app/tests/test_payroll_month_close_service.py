from __future__ import annotations

from datetime import date, datetime, time, timezone
from types import SimpleNamespace

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import AbsenceStatus, PersonType, UserRole
from app.models.payroll_month import (
    PAYROLL_MONTH_LOCKED,
    PAYROLL_MONTH_OPEN,
    PayrollMonthArtifact,
    PayrollMonthAudit,
    PayrollMonthPeriod,
    PayrollMonthPersonSnapshot,
    PayrollMonthSnapshot,
)
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.user import User
from app.services.audit_service import AuditService
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import (
    PayrollMonthExportService,
    PayrollMonthSourceBundle,
)
from app.services.payroll_period_guard import PayrollPeriodGuard


def test_guard_rejects_locked_date_and_range_with_stable_conflict_detail():
    db = database()
    locked_at = datetime(2026, 9, 3, 8, 30, tzinfo=timezone.utc)
    db.add(PayrollMonthPeriod(
        year=2026,
        month=8,
        status=PAYROLL_MONTH_LOCKED,
        locked_at=locked_at,
    ))
    db.commit()

    for mutation in (
        lambda: PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 17)),
        lambda: PayrollPeriodGuard(db).assert_range_mutable(
            date(2026, 7, 31), date(2026, 8, 1)
        ),
    ):
        with pytest.raises(HTTPException) as caught:
            mutation()
        assert caught.value.status_code == 409
        assert caught.value.detail["locked_at"].startswith("2026-09-03T08:30:00")
        assert {key: value for key, value in caught.value.detail.items() if key != "locked_at"} == {
            "code": "payroll_month_locked",
            "year": 2026,
            "month": 8,
            "message": (
                "Der Abrechnungsmonat 08/2026 ist abgeschlossen und kann nicht "
                "verändert werden. Öffnen Sie ihn zuerst in der Monatsauswertung wieder."
            ),
        }


def test_close_validation_rejects_overlaps_and_invalid_breaks_but_accepts_duration_correction():
    common = {
        "payroll_corrected_start_time": None,
        "payroll_corrected_end_time": None,
        "payroll_corrected_break_minutes": None,
        "payroll_corrected_work_minutes": None,
    }
    entries = [
        SimpleNamespace(
            **common,
            id=1,
            person_id=11,
            work_date=date(2026, 8, 3),
            start_time=time(8),
            end_time=time(12),
            break_minutes=30,
            work_minutes=210,
        ),
        SimpleNamespace(
            **common,
            id=2,
            person_id=11,
            work_date=date(2026, 8, 3),
            start_time=time(11),
            end_time=time(13),
            break_minutes=0,
            work_minutes=120,
        ),
        SimpleNamespace(
            **common,
            id=3,
            person_id=12,
            work_date=date(2026, 8, 3),
            start_time=time(8),
            end_time=time(9),
            break_minutes=60,
            work_minutes=0,
        ),
        SimpleNamespace(**(
            common
            | {
                "id": 4,
                "person_id": 13,
                "work_date": date(2026, 8, 3),
                "start_time": time(8),
                "end_time": None,
                "break_minutes": 0,
                "work_minutes": 0,
                "payroll_corrected_work_minutes": 120,
            }
        )),
        SimpleNamespace(**(
            common
            | {
                "id": 5,
                "person_id": 14,
                "work_date": date(2026, 8, 3),
                "start_time": time(8),
                "end_time": time(9),
                "break_minutes": 0,
                "work_minutes": 60,
                "payroll_corrected_start_time": time(8),
            }
        )),
    ]

    blockers = PayrollMonthCloseService._time_entry_blockers(entries)

    assert {(item.code, item.person_id) for item in blockers} == {
        ("overlapping_work_intervals", 11),
        ("invalid_break_or_interval", 12),
        ("incomplete_work_interval", 14),
    }
    assert all(item.person_id != 13 for item in blockers)


def test_close_validation_rejects_reversed_active_absence_range():
    blockers = PayrollMonthCloseService._absence_blockers(
        [
            SimpleNamespace(
                person_id=7,
                status=AbsenceStatus.ACTIVE,
                start_date=date(2026, 8, 20),
                end_date=date(2026, 8, 10),
            ),
            SimpleNamespace(
                person_id=8,
                status=AbsenceStatus.CANCELLED,
                start_date=date(2026, 8, 20),
                end_date=date(2026, 8, 10),
            ),
        ],
        month_start=date(2026, 8, 1),
        month_end=date(2026, 8, 31),
    )

    assert [(item.code, item.person_id) for item in blockers] == [
        ("invalid_absence_range", 7)
    ]


def test_weekly_review_blockers_exclude_week_crossing_into_next_month():
    db = database()
    _admin, worker = payroll_users(db)

    blockers = PayrollMonthCloseService(db)._weekly_review_blockers(
        SimpleNamespace(people=(worker,)),
        date(2026, 8, 1),
        date(2026, 8, 31),
    )

    assert [item.work_date for item in blockers] == [
        date(2026, 8, 3),
        date(2026, 8, 10),
        date(2026, 8, 17),
        date(2026, 8, 24),
    ]
    assert date(2026, 8, 31) not in {item.work_date for item in blockers}


def test_lock_reopen_and_relock_retain_versioned_snapshots_and_artifacts(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    ledger = FakeLedger(worker)
    source = PayrollMonthSourceBundle(
        year=2026,
        month=8,
        period_start=date(2026, 7, 27),
        period_end=date(2026, 9, 6),
        people=(worker,),
        entries=(),
        absences=(),
        work_days=(),
        holidays=frozenset(),
    )
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(service, "_ledger_service", lambda: ledger)
    monkeypatch.setattr(
        PayrollMonthExportService,
        "load_live_source",
        lambda *_args, **_kwargs: source,
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    def artifacts(*, year, month, version, person_values, **_kwargs):
        assert person_values[0]["opening_balance_minutes"] == 90
        assert person_values[0]["closing_balance_minutes"] == 150
        return [
            {
                "artifact_key": "all_workers",
                "person_id": None,
                "filename": (
                    f"lohnabrechnung_{year}_{month:02d}_alle_monteure_v{version}.xlsx"
                ),
                "content": f"all-v{version}".encode(),
            },
            {
                "artifact_key": f"worker:{worker.id}",
                "person_id": worker.id,
                "filename": (
                    f"lohnabrechnung_{year}_{month:02d}_person_{worker.id}_v{version}.xlsx"
                ),
                "content": f"worker-v{version}".encode(),
            },
        ]

    monkeypatch.setattr(service, "_build_artifact_specs", artifacts)

    first = service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)
    assert first.status == PAYROLL_MONTH_LOCKED
    assert first.snapshot_version == 1
    assert first.artifacts_ready is True

    opened = service.reopen_month(
        year=2026,
        month=8,
        reason="Korrektur eines geprüften Zeiteintrags",
        current_user=admin,
    )
    assert opened.status == PAYROLL_MONTH_OPEN
    assert opened.snapshot_version == 1
    assert opened.artifacts_ready is False

    second = service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)
    assert second.status == PAYROLL_MONTH_LOCKED
    assert second.snapshot_version == 2
    assert second.artifacts_ready is True

    snapshots = list(db.scalars(select(PayrollMonthSnapshot).order_by(PayrollMonthSnapshot.version)))
    assert [item.version for item in snapshots] == [1, 2]
    artifacts_rows = list(
        db.scalars(select(PayrollMonthArtifact).order_by(PayrollMonthArtifact.id))
    )
    assert [item.filename for item in artifacts_rows] == [
        "lohnabrechnung_2026_08_alle_monteure_v1.xlsx",
        f"lohnabrechnung_2026_08_person_{worker.id}_v1.xlsx",
        "lohnabrechnung_2026_08_alle_monteure_v2.xlsx",
        f"lohnabrechnung_2026_08_person_{worker.id}_v2.xlsx",
    ]
    assert len(list(db.scalars(select(PayrollMonthPersonSnapshot)))) == 2
    actions = list(db.scalars(select(PayrollMonthAudit.action).order_by(PayrollMonthAudit.id)))
    assert actions == [
        "EXPORT_CREATED",
        "EXPORT_CREATED",
        "MONTH_LOCKED",
        "MONTH_REOPENED",
        "EXPORT_CREATED",
        "EXPORT_CREATED",
        "MONTH_RELOCKED",
    ]
    assert ledger.finalized_references == [
        "payroll-month:2026-08:v1",
        "payroll-month:2026-08:v2",
    ]
    assert ledger.unfinalized_references == ["payroll-month:2026-08:v1"]

    export_service = PayrollMonthExportService(db)
    assert export_service.worker_export(
        person_id=worker.id,
        year=2026,
        month=8,
        version=2,
        current_user=admin,
    ) == b"worker-v2"
    with pytest.raises(HTTPException) as stale:
        export_service.worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            version=1,
            current_user=admin,
        )
    assert stale.value.status_code == 409
    assert stale.value.detail["code"] == "payroll_snapshot_version_stale"


def test_artifacts_ready_requires_complete_set_and_download_checks_hash(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    period = PayrollMonthPeriod(
        year=2026,
        month=8,
        status=PAYROLL_MONTH_LOCKED,
        last_snapshot_version=1,
        locked_at=datetime.now(timezone.utc),
        locked_by_user_id=admin.id,
    )
    db.add(period)
    db.flush()
    snapshot = PayrollMonthSnapshot(
        period_id=period.id,
        version=1,
        reference_id="payroll-month:2026-08:v1",
        period_start=date(2026, 8, 1),
        period_end=date(2026, 8, 31),
        cutover_date=date(2026, 8, 1),
        payload_json={},
        payload_sha256="0" * 64,
    )
    db.add(snapshot)
    db.flush()
    db.add(PayrollMonthPersonSnapshot(
        snapshot_id=snapshot.id,
        person_id=worker.id,
        person_name=worker.display_name,
        opening_balance_minutes=0,
        movement_minutes=0,
        closing_balance_minutes=0,
        daily_values_json=[],
        source_sha256="0" * 64,
    ))
    db.add(PayrollMonthArtifact(
        snapshot_id=snapshot.id,
        artifact_key="all_workers",
        filename="all_v1.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content=b"all",
        byte_size=3,
        content_sha256="5ef5ef0364b6939c4ca61f34b393f7b368d1be8619647aaf83d5b395919ab629",
    ))
    db.commit()

    assert service.get_status(year=2026, month=8, current_user=admin).artifacts_ready is False

    corrupt = PayrollMonthArtifact(
        snapshot_id=snapshot.id,
        artifact_key=f"worker:{worker.id}",
        person_id=worker.id,
        filename=f"worker_{worker.id}_v1.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content=b"worker",
        byte_size=6,
        content_sha256="not-the-content-hash",
    )
    db.add(corrupt)
    db.commit()
    assert service.get_status(year=2026, month=8, current_user=admin).artifacts_ready is False
    with pytest.raises(HTTPException) as caught:
        PayrollMonthExportService(db).worker_export(
            person_id=worker.id,
            year=2026,
            month=8,
            version=1,
            current_user=admin,
        )
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_artifact_corrupt"


def test_project_manager_cannot_lock_or_reopen_payroll_month():
    db = database()
    project_manager = User(
        username="project-payroll",
        display_name="Projektleitung",
        password_hash="test",
        role=UserRole.PROJECT_MANAGER,
        is_active=True,
        must_change_password=False,
    )
    db.add(project_manager)
    db.commit()
    service = PayrollMonthCloseService(db)

    with pytest.raises(HTTPException) as lock_error:
        service.lock_month(
            year=2026,
            month=8,
            confirmed=True,
            current_user=project_manager,
        )
    assert lock_error.value.status_code == 403

    with pytest.raises(HTTPException) as reopen_error:
        service.reopen_month(
            year=2026,
            month=8,
            reason="Nicht berechtigt",
            current_user=project_manager,
        )
    assert reopen_error.value.status_code == 403


def test_older_month_cannot_reopen_while_later_month_is_locked():
    db = database()
    admin, _worker = payroll_users(db)
    db.add_all([
        PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_LOCKED),
        PayrollMonthPeriod(year=2026, month=9, status=PAYROLL_MONTH_LOCKED),
    ])
    db.commit()

    with pytest.raises(HTTPException) as caught:
        PayrollMonthCloseService(db).reopen_month(
            year=2026,
            month=8,
            reason="Korrektur",
            current_user=admin,
        )

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_later_month_locked"


def test_failed_close_rolls_back_daily_rows_snapshot_and_artifacts(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    service = PayrollMonthCloseService(db)
    source = PayrollMonthSourceBundle(
        year=2026,
        month=8,
        period_start=date(2026, 7, 27),
        period_end=date(2026, 9, 6),
        people=(worker,),
        entries=(),
        absences=(),
        work_days=(),
        holidays=frozenset(),
    )
    monkeypatch.setattr(service, "_readiness_blockers", lambda *_args: [])
    monkeypatch.setattr(
        PayrollMonthExportService,
        "load_live_source",
        lambda *_args, **_kwargs: source,
    )
    monkeypatch.setattr(AuditService, "record", lambda *_args, **_kwargs: None)

    class DbWritingLedger:
        def finalize_month(self, **_values):
            db.add(PersonHoursAccountEntry(
                person_id=worker.id,
                entry_type="daily_balance",
                minutes_delta=0,
                balance_after_minutes=0,
                note="Muss zurückgerollt werden",
                ledger_system="daily",
                effective_date=date(2026, 8, 3),
                source_type="payroll_month_close",
                source_reference_id="payroll-month:2026-08:v1",
                idempotency_key="rollback-proof",
                is_active=True,
            ))
            db.flush()
            return SimpleNamespace(people=(SimpleNamespace(
                person_id=worker.id,
                person_name=worker.display_name,
                opening_balance_minutes=0,
                movement_minutes=0,
                closing_balance_minutes=0,
                days=[],
            ),))

    monkeypatch.setattr(service, "_ledger_service", lambda: DbWritingLedger())
    monkeypatch.setattr(
        service,
        "_build_artifact_specs",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("Export fehlgeschlagen")),
    )

    with pytest.raises(RuntimeError, match="Export fehlgeschlagen"):
        service.lock_month(year=2026, month=8, confirmed=True, current_user=admin)

    period = db.scalar(select(PayrollMonthPeriod).where(
        PayrollMonthPeriod.year == 2026,
        PayrollMonthPeriod.month == 8,
    ))
    assert period is not None
    assert period.status == PAYROLL_MONTH_OPEN
    assert db.scalar(select(PersonHoursAccountEntry.id)) is None
    assert db.scalar(select(PayrollMonthSnapshot.id)) is None
    assert db.scalar(select(PayrollMonthArtifact.id)) is None
    assert list(db.scalars(select(PayrollMonthAudit.action))) == ["MONTH_LOCK_FAILED"]


class FakeLedger:
    def __init__(self, worker: Person) -> None:
        self.worker = worker
        self.finalized_references: list[str] = []
        self.unfinalized_references: list[str] = []

    def finalize_month(self, **values):
        self.finalized_references.append(values["reference_id"])
        return SimpleNamespace(people=(SimpleNamespace(
            person_id=self.worker.id,
            person_name=self.worker.display_name,
            opening_balance_minutes=90,
            movement_minutes=60,
            closing_balance_minutes=150,
            days=[{
                "work_date": "2026-08-03",
                "target_minutes": 480,
                "actual_minutes": 540,
                "movement_minutes": 60,
            }],
        ),))

    def unfinalize_month(self, **values):
        self.unfinalized_references.append(values["reference_id"])
        return 1


def database() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def payroll_users(db: Session) -> tuple[User, Person]:
    worker = Person(
        first_name="Anna",
        last_name="Bau",
        display_name="Anna Bau",
        short_code="AB",
        person_type=PersonType.INTERNAL,
        is_active=True,
        weekly_hours=40,
    )
    admin = User(
        username="admin-payroll",
        display_name="Lohnbüro",
        password_hash="test",
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )
    db.add_all([worker, admin])
    db.commit()
    return admin, worker
