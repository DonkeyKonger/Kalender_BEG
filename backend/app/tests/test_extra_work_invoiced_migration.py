import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260825_0104_add_extra_work_invoiced_marker.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_invoiced_0104", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_extra_work_invoiced_migration_defaults_existing_and_new_tickets_to_false(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("display_number", sa.String(length=120), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(tickets.insert(), {"id": 1, "display_number": "8007.Z01"})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()
        connection.execute(
            sa.text("INSERT INTO extra_work_tickets (id, display_number) VALUES (2, '8007.Z02')")
        )

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_tickets")
        }
        rows = connection.execute(
            sa.text("SELECT id, is_invoiced FROM extra_work_tickets ORDER BY id")
        ).mappings().all()

    assert columns["is_invoiced"]["nullable"] is False
    assert rows == [
        {"id": 1, "is_invoiced": False},
        {"id": 2, "is_invoiced": False},
    ]
