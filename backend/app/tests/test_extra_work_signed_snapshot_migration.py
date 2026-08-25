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
    / "20260825_0105_add_extra_work_signed_photo_snapshots.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_signed_snapshot_0105", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_signed_snapshot_migration_is_idempotent_and_marks_legacy_rows(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_signed_at", sa.DateTime(timezone=True)),
    )
    photos = sa.Table(
        "extra_work_ticket_photos",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("extra_work_ticket_id", sa.Integer(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(tickets.insert(), [
            {"id": 1, "customer_signed_at": datetime(2026, 8, 1, 12, tzinfo=UTC)},
            {"id": 2, "customer_signed_at": None},
        ])
        connection.execute(photos.insert(), {"id": 1, "extra_work_ticket_id": 1})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()
        connection.execute(
            sa.text("INSERT INTO extra_work_ticket_photos (id, extra_work_ticket_id) VALUES (2, 2)")
        )
        ticket_rows = connection.execute(
            sa.text("SELECT id, signed_snapshot_kind FROM extra_work_tickets ORDER BY id")
        ).mappings().all()
        photo_rows = connection.execute(
            sa.text(
                "SELECT id, customer_document_selected FROM extra_work_ticket_photos ORDER BY id"
            )
        ).mappings().all()

    assert ticket_rows == [
        {"id": 1, "signed_snapshot_kind": "legacy_pending_freeze"},
        {"id": 2, "signed_snapshot_kind": None},
    ]
    assert photo_rows == [
        {"id": 1, "customer_document_selected": True},
        {"id": 2, "customer_document_selected": True},
    ]
