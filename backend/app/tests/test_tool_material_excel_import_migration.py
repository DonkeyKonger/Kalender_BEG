import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260717_0092_add_tool_excel_import_identity.py"
)
SPEC = importlib.util.spec_from_file_location("tool_excel_import_0092", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_migration_allows_repeated_beg_numbers_and_adds_unique_import_key(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("beg_number", sa.String(120)),
        sa.Column("designation", sa.String(240), nullable=False),
    )
    sa.Index("ix_tool_material_items_beg_number", table.c.beg_number, unique=True)
    metadata.create_all(engine)
    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)
        MIGRATION.upgrade()
        inspector = sa.inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
        indexes = {index["name"]: index for index in inspector.get_indexes("tool_material_items")}
        connection.execute(
            sa.text(
                "INSERT INTO tool_material_items (id, beg_number, designation, import_key) "
                "VALUES (1, '20000', 'Sauger', 'a'), (2, '20000', 'Akku', 'b')"
            )
        )

    assert {"import_source", "import_sheet", "import_row_number", "import_key"} <= columns
    assert indexes["ix_tool_material_items_beg_number"]["unique"] == 0
    assert indexes["ix_tool_material_items_import_key"]["unique"] == 1
