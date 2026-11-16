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
    / "20261116_0132_material_order_drafts.py"
)
SPEC = importlib.util.spec_from_file_location("material_order_0132", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_material_order_migration_enforces_one_open_draft_per_site_user(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("sites", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(sa.text("INSERT INTO sites (id) VALUES (1)"))
        connection.execute(sa.text("INSERT INTO users (id) VALUES (2)"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)
        MIGRATION.upgrade()

        connection.execute(sa.text(
            "INSERT INTO material_order_drafts "
            "(id, site_id, user_id, revision, \"values\", status) "
            "VALUES ('draft-1', 1, 2, 0, '{}', 'draft')"
        ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO material_order_drafts "
                "(id, site_id, user_id, revision, \"values\", status) "
                "VALUES ('draft-2', 1, 2, 0, '{}', 'draft')"
            ))
        connection.execute(sa.text(
            "INSERT INTO material_order_drafts "
            "(id, site_id, user_id, revision, \"values\", status) "
            "VALUES ('completed-1', 1, 2, 1, '{}', 'completed'), "
            "('completed-2', 1, 2, 1, '{}', 'completed')"
        ))

        indexes = {index["name"] for index in sa.inspect(connection).get_indexes("material_order_drafts")}
        assert "uq_material_order_drafts_open_site_user" in indexes

        MIGRATION.downgrade()
        assert "material_order_drafts" not in sa.inspect(connection).get_table_names()
