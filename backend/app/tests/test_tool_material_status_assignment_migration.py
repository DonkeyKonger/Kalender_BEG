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
    / "20260715_0078_enforce_tool_material_status_assignment.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "tool_material_status_assignment_0078",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_repairs_and_rejects_status_employee_contradictions(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("employee_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [
                {"id": 1, "employee_id": 7, "status": "warehouse"},
                {"id": 2, "employee_id": 8, "status": "defective"},
                {"id": 3, "employee_id": 9, "status": "issued"},
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)
        MIGRATION_MODULE.upgrade()

        migrated = connection.execute(
            sa.text("SELECT id, employee_id, status FROM tool_material_items ORDER BY id")
        ).mappings().all()
        constraints = {
            constraint["name"]
            for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
        }
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_items (id, employee_id, status) "
                    "VALUES (4, 10, 'warehouse')"
                )
            )

    assert migrated == [
        {"id": 1, "employee_id": None, "status": "warehouse"},
        {"id": 2, "employee_id": None, "status": "defective"},
        {"id": 3, "employee_id": 9, "status": "issued"},
    ]
    assert "ck_tool_material_items_status_employee" in constraints
