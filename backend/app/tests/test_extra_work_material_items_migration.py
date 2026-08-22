import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260822_0101_add_extra_work_material_items.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_material_items_0101", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_material_items_migration_is_nullable_idempotent_and_preserves_legacy_text(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    entries = sa.Table(
        "extra_work_ticket_entries",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("material_text", sa.Text(), nullable=True),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(entries.insert(), {"id": 1, "material_text": "Kabelrinne alt"})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_ticket_entries")
        }
        legacy_row = connection.execute(sa.text(
            "SELECT material_text, material_items FROM extra_work_ticket_entries WHERE id = 1"
        )).mappings().one()

    assert columns["material_items"]["nullable"] is True
    assert legacy_row["material_text"] == "Kabelrinne alt"
    assert legacy_row["material_items"] is None
