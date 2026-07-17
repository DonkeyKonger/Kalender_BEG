import importlib.util
from datetime import date
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260717_0090_index_tool_material_item_date.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "tool_material_performance_0090",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_indexes_tool_material_date_without_changing_data(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tools = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
        sa.Column("item_date", sa.Date(), nullable=True),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            tools.insert().values(
                id=1,
                designation="Bestandsgerät",
                item_date=date(2026, 7, 17),
            )
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()
        MIGRATION_MODULE.upgrade()

        indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
        stored = connection.execute(
            sa.text("SELECT id, designation, item_date FROM tool_material_items")
        ).mappings().one()

    assert "ix_tool_material_items_item_date" in indexes
    assert stored == {
        "id": 1,
        "designation": "Bestandsgerät",
        "item_date": "2026-07-17",
    }
