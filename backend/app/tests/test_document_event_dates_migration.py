import importlib.util
from datetime import UTC, datetime
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20261116_0133_add_document_event_dates.py"
)
SPEC = importlib.util.spec_from_file_location("document_event_dates_0133", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def _as_utc(value: object) -> datetime | None:
    if value is None:
        return None
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    return parsed.replace(tzinfo=parsed.tzinfo or UTC).astimezone(UTC)


def test_migration_backfills_only_evidenced_document_events(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    measurements = sa.Table(
        "site_measurement_batches",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("submitted_by_user_id", sa.Integer()),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("first_submitted_at", sa.DateTime(timezone=True)),
        sa.Column("original_submitted_snapshot", sa.JSON()),
        sa.Column("status_history", sa.JSON(), nullable=False),
    )
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("submitted_by_user_id", sa.Integer()),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("invoiced_at", sa.DateTime(timezone=True)),
    )
    audit_logs = sa.Table(
        "audit_logs",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.Integer()),
        sa.Column("new_value_json", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    metadata.create_all(engine)
    submitted_at = datetime(2026, 11, 3, 8, tzinfo=UTC)
    reviewed_at = datetime(2026, 11, 4, 8, tzinfo=UTC)
    completed_at = datetime(2026, 11, 5, 8, tzinfo=UTC)
    contaminated_at = datetime(2026, 11, 1, 8, tzinfo=UTC)

    with engine.begin() as connection:
        connection.execute(
            measurements.insert(),
            [
                {
                    "id": 1,
                    "origin": "MONTEUR",
                    "submitted_by_user_id": 7,
                    "submitted_at": submitted_at,
                    "first_submitted_at": None,
                    "original_submitted_snapshot": {
                        "submitted_at": submitted_at.isoformat()
                    },
                    "status_history": [
                        {
                            "kind": "advance",
                            "from": "submitted",
                            "to": "reviewed",
                            "at": reviewed_at.isoformat(),
                        }
                    ],
                },
                {
                    "id": 2,
                    "origin": "OFFICE",
                    "submitted_by_user_id": None,
                    "submitted_at": None,
                    "first_submitted_at": None,
                    "original_submitted_snapshot": None,
                    "status_history": [],
                },
                {
                    "id": 3,
                    "origin": "OFFICE",
                    "submitted_by_user_id": None,
                    "submitted_at": None,
                    "first_submitted_at": contaminated_at,
                    "original_submitted_snapshot": None,
                    "status_history": [],
                },
                {
                    "id": 4,
                    "origin": "MONTEUR",
                    "submitted_by_user_id": None,
                    "submitted_at": completed_at,
                    "first_submitted_at": submitted_at,
                    "original_submitted_snapshot": None,
                    "status_history": [],
                },
                {
                    "id": 5,
                    "origin": "MONTEUR",
                    "submitted_by_user_id": 8,
                    "submitted_at": completed_at,
                    "first_submitted_at": contaminated_at,
                    "original_submitted_snapshot": {
                        "submitted_at": submitted_at.isoformat()
                    },
                    "status_history": [],
                },
            ],
        )
        connection.execute(
            tickets.insert(),
            [
                {
                    "id": 10,
                    "submitted_by_user_id": 9,
                    "submitted_at": submitted_at,
                    "invoiced_at": completed_at,
                },
                {
                    "id": 11,
                    "submitted_by_user_id": None,
                    "submitted_at": submitted_at,
                    "invoiced_at": None,
                },
                {
                    "id": 12,
                    "submitted_by_user_id": None,
                    "submitted_at": None,
                    "invoiced_at": None,
                },
            ],
        )
        connection.execute(
            audit_logs.insert(),
            [
                {
                    "id": 1,
                    "action": "measurement.status_promoted",
                    "entity_type": "site_measurement_batch",
                    "entity_id": 2,
                    "new_value_json": {"status": "billed"},
                    "created_at": completed_at,
                },
                {
                    "id": 2,
                    "action": "extra_work.status_promoted",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 11,
                    "new_value_json": {"status": "billed"},
                    "created_at": completed_at,
                },
                {
                    "id": 3,
                    "action": "extra_work.status_promoted",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 10,
                    "new_value_json": {"status": "submitted"},
                    "created_at": reviewed_at,
                },
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        measurement_rows = connection.execute(
            sa.text(
                "SELECT id, first_submitted_at, first_worker_submitted_at, "
                "first_reviewed_or_completed_at "
                "FROM site_measurement_batches ORDER BY id"
            )
        ).mappings().all()
        ticket_rows = connection.execute(
            sa.text(
                "SELECT id, first_submitted_at, first_reviewed_or_completed_at "
                "FROM extra_work_tickets ORDER BY id"
            )
        ).mappings().all()

    assert measurement_rows[0]["first_submitted_at"] is None
    assert _as_utc(measurement_rows[0]["first_worker_submitted_at"]) == submitted_at
    assert (
        _as_utc(measurement_rows[0]["first_reviewed_or_completed_at"])
        == reviewed_at
    )
    assert measurement_rows[1]["first_submitted_at"] is None
    assert measurement_rows[1]["first_worker_submitted_at"] is None
    assert (
        _as_utc(measurement_rows[1]["first_reviewed_or_completed_at"])
        == completed_at
    )
    assert _as_utc(measurement_rows[2]["first_submitted_at"]) == contaminated_at
    assert measurement_rows[2]["first_worker_submitted_at"] is None
    assert measurement_rows[2]["first_reviewed_or_completed_at"] is None
    assert _as_utc(measurement_rows[3]["first_submitted_at"]) == submitted_at
    assert _as_utc(measurement_rows[3]["first_worker_submitted_at"]) == submitted_at
    assert _as_utc(measurement_rows[4]["first_submitted_at"]) == contaminated_at
    assert _as_utc(measurement_rows[4]["first_worker_submitted_at"]) == submitted_at
    assert _as_utc(ticket_rows[0]["first_submitted_at"]) == submitted_at
    assert _as_utc(ticket_rows[0]["first_reviewed_or_completed_at"]) == completed_at
    assert _as_utc(ticket_rows[1]["first_submitted_at"]) == submitted_at
    assert _as_utc(ticket_rows[1]["first_reviewed_or_completed_at"]) == completed_at
    assert ticket_rows[2]["first_submitted_at"] is None
    assert ticket_rows[2]["first_reviewed_or_completed_at"] is None
