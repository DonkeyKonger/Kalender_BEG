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
    / "20260715_0083_add_tool_material_responsibility.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "tool_material_responsibility_0083",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_adds_empty_singleton_without_changing_tool_items(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    users = sa.Table(
        "users",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
    )
    items = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(users.insert().values(id=1))
        connection.execute(items.insert().values(id=7, designation="Bestandsgerät"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        inspector = sa.inspect(connection)
        settings = connection.execute(
            sa.text(
                "SELECT id, tool_responsible_user_id "
                "FROM tool_material_settings"
            )
        ).mappings().all()
        existing_items = connection.execute(
            sa.text("SELECT id, designation FROM tool_material_items")
        ).mappings().all()
        foreign_keys = inspector.get_foreign_keys("tool_material_settings")
        constraints = inspector.get_check_constraints("tool_material_settings")

        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO tool_material_settings "
                    "(id, tool_responsible_user_id) VALUES (2, NULL)"
                )
            )

    assert settings == [{"id": 1, "tool_responsible_user_id": None}]
    assert existing_items == [{"id": 7, "designation": "Bestandsgerät"}]
    assert foreign_keys[0]["referred_table"] == "users"
    assert foreign_keys[0]["options"]["ondelete"] == "SET NULL"
    assert constraints[0]["sqltext"] == "id = 1"
