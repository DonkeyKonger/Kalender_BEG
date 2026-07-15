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
    / "20260715_0080_replace_defective_tool_material_status.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "tool_material_written_off_status_0080",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_preserves_and_renames_defective_items(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("employee_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.CheckConstraint(
            "status IN ('issued', 'warehouse', 'defective')",
            name="ck_tool_material_items_status",
        ),
        sa.CheckConstraint(
            "status = 'issued' OR employee_id IS NULL",
            name="ck_tool_material_items_status_employee",
        ),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [
                {"id": 1, "employee_id": 7, "status": "issued"},
                {"id": 2, "employee_id": None, "status": "warehouse"},
                {"id": 3, "employee_id": None, "status": "defective"},
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        migrated = connection.execute(
            sa.text(
                "SELECT id, employee_id, status "
                "FROM tool_material_items ORDER BY id"
            )
        ).mappings().all()
        constraints = {
            constraint["name"]: constraint["sqltext"]
            for constraint in sa.inspect(connection).get_check_constraints(
                "tool_material_items"
            )
        }
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_items (id, employee_id, status) "
                    "VALUES (4, NULL, 'defective')"
                )
            )
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_items (id, employee_id, status) "
                    "VALUES (5, 11, 'written_off')"
                )
            )

    assert migrated == [
        {"id": 1, "employee_id": 7, "status": "issued"},
        {"id": 2, "employee_id": None, "status": "warehouse"},
        {"id": 3, "employee_id": None, "status": "written_off"},
    ]
    assert "written_off" in constraints["ck_tool_material_items_status"]
    assert "defective" not in constraints["ck_tool_material_items_status"]
    assert "ck_tool_material_items_status_employee" in constraints


def test_migration_clears_legacy_employee_assignment_before_rename(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    table = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("employee_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.CheckConstraint(
            "status IN ('issued', 'warehouse', 'defective')",
            name="ck_tool_material_items_status",
        ),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            {"id": 1, "employee_id": 9, "status": "defective"},
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        migrated = connection.execute(
            sa.text(
                "SELECT employee_id, status FROM tool_material_items WHERE id = 1"
            )
        ).mappings().one()

    assert migrated == {"employee_id": None, "status": "written_off"}
