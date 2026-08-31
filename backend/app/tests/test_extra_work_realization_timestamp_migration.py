import importlib.util
from datetime import datetime, timezone
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260831_0107_backfill_extra_work_invoiced_timestamps.py"
)
SPEC = importlib.util.spec_from_file_location(
    "extra_work_realization_timestamp_0107", MIGRATION_PATH
)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_backfill_uses_first_audited_invoice_marker_without_reactivating_unbilled_tickets(
    monkeypatch,
):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("is_invoiced", sa.Boolean(), nullable=False),
        sa.Column("invoiced_at", sa.DateTime(timezone=True)),
    )
    audit_logs = sa.Table(
        "audit_logs",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("new_value_json", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    metadata.create_all(engine)
    first_invoice = datetime(2026, 8, 3, 9, tzinfo=timezone.utc)
    second_invoice = datetime(2026, 8, 5, 9, tzinfo=timezone.utc)
    existing_timestamp = datetime(2026, 8, 1, 9, tzinfo=timezone.utc)

    with engine.begin() as connection:
        connection.execute(
            tickets.insert(),
            [
                {"id": 1, "is_invoiced": True, "invoiced_at": None},
                {"id": 2, "is_invoiced": False, "invoiced_at": None},
                {"id": 3, "is_invoiced": True, "invoiced_at": existing_timestamp},
            ],
        )
        connection.execute(
            audit_logs.insert(),
            [
                {
                    "id": 1,
                    "action": "extra_work.invoiced_updated",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 1,
                    "new_value_json": {"is_invoiced": True},
                    "created_at": first_invoice,
                },
                {
                    "id": 2,
                    "action": "extra_work.invoiced_updated",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 1,
                    "new_value_json": {"is_invoiced": False},
                    "created_at": datetime(2026, 8, 4, 9, tzinfo=timezone.utc),
                },
                {
                    "id": 3,
                    "action": "extra_work.invoiced_updated",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 1,
                    "new_value_json": {"is_invoiced": True},
                    "created_at": second_invoice,
                },
                {
                    "id": 4,
                    "action": "extra_work.invoiced_updated",
                    "entity_type": "extra_work_ticket",
                    "entity_id": 2,
                    "new_value_json": {"is_invoiced": True},
                    "created_at": first_invoice,
                },
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        rows = connection.execute(
            sa.text(
                "SELECT id, is_invoiced, invoiced_at "
                "FROM extra_work_tickets ORDER BY id"
            )
        ).mappings().all()

    assert bool(rows[0]["is_invoiced"]) is True
    assert datetime.fromisoformat(str(rows[0]["invoiced_at"])).replace(
        tzinfo=timezone.utc
    ) == first_invoice
    assert bool(rows[1]["is_invoiced"]) is False
    assert rows[1]["invoiced_at"] is None
    assert datetime.fromisoformat(str(rows[2]["invoiced_at"])).replace(
        tzinfo=timezone.utc
    ) == existing_timestamp
