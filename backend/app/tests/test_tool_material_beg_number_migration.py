import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260715_0076_add_tool_material_beg_number.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("tool_material_beg_number_0076", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_keeps_existing_items_without_beg_number(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    old_table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(old_table.insert().values(id=1, designation="Bestandsgerät"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)
        MIGRATION_MODULE.upgrade()

        columns = {column["name"]: column for column in sa.inspect(connection).get_columns("tool_material_items")}
        indexes = {index["name"]: index for index in sa.inspect(connection).get_indexes("tool_material_items")}
        migrated = connection.execute(
            sa.text("SELECT id, designation, beg_number FROM tool_material_items WHERE id = 1")
        ).mappings().one()

    assert columns["beg_number"]["nullable"] is True
    assert indexes["ix_tool_material_items_beg_number"]["unique"] == 1
    assert migrated == {"id": 1, "designation": "Bestandsgerät", "beg_number": None}
