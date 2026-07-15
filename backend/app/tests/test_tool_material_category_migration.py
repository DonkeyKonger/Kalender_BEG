import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260715_0081_add_tool_material_category.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("tool_material_category_0081", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_category_migration_preserves_existing_items_as_other(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(table.insert(), {"id": 1, "designation": "Bestandsgerät"})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        migrated = connection.execute(
            sa.text("SELECT category FROM tool_material_items WHERE id = 1")
        ).scalar_one()
        constraints = {
            constraint["name"]
            for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
        }
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_items (id, designation, category) "
                    "VALUES (2, 'Ungültig', 'frei erfunden')"
                )
            )

    assert migrated == "other"
    assert "ck_tool_material_items_category" in constraints
