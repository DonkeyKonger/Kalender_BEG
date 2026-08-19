import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260819_0099_add_worker_signature_details.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_signature_details_0099", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_worker_signature_details_migration_is_nullable_idempotent_and_preserves_history(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("worker_signature_name", sa.String(length=160)),
        sa.Column("worker_signature_strokes", sa.JSON()),
        sa.Column("worker_signed_at", sa.DateTime(timezone=True)),
    )
    metadata.create_all(engine)

    historical_strokes = [[{"x": 0.1, "y": 0.2}, {"x": 0.8, "y": 0.7}]]
    with engine.begin() as connection:
        connection.execute(
            tickets.insert(),
            {
                "id": 41,
                "worker_signature_name": "Max Monteur",
                "worker_signature_strokes": historical_strokes,
            },
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_tickets")
        }
        row = connection.execute(
            sa.text(
                "SELECT worker_signature_name, worker_signature_place, "
                "worker_signature_date, worker_signature_strokes "
                "FROM extra_work_tickets WHERE id = 41"
            )
        ).mappings().one()

    assert columns["worker_signature_place"]["nullable"] is True
    assert columns["worker_signature_date"]["nullable"] is True
    assert row["worker_signature_name"] == "Max Monteur"
    assert row["worker_signature_place"] is None
    assert row["worker_signature_date"] is None
    assert json.loads(row["worker_signature_strokes"]) == historical_strokes
