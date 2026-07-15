import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260715_0077_add_tool_material_status.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("tool_material_status_0077", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_derives_status_from_existing_employee_assignment(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    old_table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
        sa.Column("employee_id", sa.Integer(), nullable=True),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            old_table.insert(),
            [
                {"id": 1, "designation": "Ausgegebenes Gerät", "employee_id": 12},
                {"id": 2, "designation": "Lagergerät", "employee_id": None},
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)
        MIGRATION_MODULE.upgrade()

        columns = {column["name"]: column for column in sa.inspect(connection).get_columns("tool_material_items")}
        indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
        constraints = {
            constraint["name"]
            for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
        }
        migrated = connection.execute(
            sa.text("SELECT id, status FROM tool_material_items ORDER BY id")
        ).mappings().all()
        try:
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_items "
                    "(id, designation, employee_id, status) "
                    "VALUES (3, 'Ungültig', NULL, 'frei erfunden')"
                )
            )
        except sa.exc.IntegrityError:
            invalid_status_rejected = True
        else:
            invalid_status_rejected = False

    assert columns["status"]["nullable"] is False
    assert "ix_tool_material_items_status" in indexes
    assert "ck_tool_material_items_status" in constraints
    assert invalid_status_rejected is True
    assert migrated == [
        {"id": 1, "status": "issued"},
        {"id": 2, "status": "warehouse"},
    ]
