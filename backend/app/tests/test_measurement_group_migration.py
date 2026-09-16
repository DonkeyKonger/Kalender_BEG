import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_group_migration_preserves_originals_and_enforces_active_membership(monkeypatch):
    path = Path(__file__).parents[2] / "alembic/versions/20260916_0119_measurement_groups.py"
    spec = importlib.util.spec_from_file_location("measurement_groups_0119", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        for table in ["sites", "users", "site_measurement_batches"]:
            connection.execute(sa.text(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
            connection.execute(sa.text(f"INSERT INTO {table} (id) VALUES (1)"))
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        for group_id in [1, 2]:
            connection.execute(sa.text("INSERT INTO measurement_groups (id, site_id, number_label, sources, snapshot, position_count, worker_signature_count, has_customer_signature) VALUES (:id, 1, :label, '[]', '{}', 0, 0, false)"), {"id": group_id, "label": f"8007.{group_id}G"})
        connection.execute(sa.text("INSERT INTO measurement_group_members VALUES (1, 1, true)"))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text("INSERT INTO measurement_group_members VALUES (2, 1, true)"))
        connection.execute(sa.text("UPDATE measurement_group_members SET active = false WHERE group_id = 1"))
        connection.execute(sa.text("INSERT INTO measurement_group_members VALUES (2, 1, true)"))
        migration.downgrade()
        assert connection.scalar(sa.text("SELECT count(*) FROM site_measurement_batches")) == 1
        assert "measurement_groups" not in sa.inspect(connection).get_table_names()
