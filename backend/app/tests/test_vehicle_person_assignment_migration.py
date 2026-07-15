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
    / "20260715_0082_add_vehicle_asset_person_assignment.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "vehicle_person_assignment_0082",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_vehicle_assignment_migration_preserves_assets_and_enforces_one_current_vehicle(
    monkeypatch,
):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    persons = sa.Table(
        "persons",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
    )
    assets = sa.Table(
        "vehicle_assets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("external_id", sa.String(120), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(persons.insert(), [{"id": 1}, {"id": 2}])
        connection.execute(assets.insert(), {"id": 10, "external_id": "existing"})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        migrated_columns = {
            column["name"] for column in sa.inspect(connection).get_columns("vehicle_assets")
        }
        migrated_asset = connection.execute(
            sa.text("SELECT external_id, assigned_person_id FROM vehicle_assets WHERE id = 10")
        ).one()
        connection.execute(
            sa.text("UPDATE vehicle_assets SET assigned_person_id = 1 WHERE id = 10")
        )
        connection.execute(
            sa.text(
                "INSERT INTO vehicle_assets (id, external_id, assigned_person_id) "
                "VALUES (11, 'second', 2)"
            )
        )
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO vehicle_assets (id, external_id, assigned_person_id) "
                    "VALUES (12, 'duplicate', 1)"
                )
            )

    assert "assigned_person_id" in migrated_columns
    assert tuple(migrated_asset) == ("existing", None)
