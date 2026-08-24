import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260824_0102_add_extra_work_ticket_customer_name.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_customer_name_0102", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_customer_name_migration_is_nullable_idempotent_and_preserves_legacy_ticket(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("display_number", sa.String(length=120), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(
            tickets.insert(),
            {"id": 1, "site_id": 9, "display_number": "9999.SZ01"},
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_tickets")
        }
        legacy_value = connection.scalar(sa.text(
            "SELECT customer_name FROM extra_work_tickets WHERE id = 1"
        ))

    assert columns["customer_name"]["nullable"] is True
    assert columns["customer_name"]["type"].length == 200
    assert legacy_value is None
