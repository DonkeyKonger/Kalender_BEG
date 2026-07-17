import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260717_0091_add_vehicle_database_links.py"
)
SPEC = importlib.util.spec_from_file_location("vehicle_database_0091", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_vehicle_database_migration_backfills_manufacturer_and_enforces_links(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("vehicle_assets", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    vehicles = sa.Table(
        "vehicles",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("license_plate", sa.String(30), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(
            vehicles.insert(),
            {"id": 1, "license_plate": "OHZ-BE 1", "name": "Volkswagen"},
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)
        MIGRATION.upgrade()

        columns = {
            column["name"]: column for column in sa.inspect(connection).get_columns("vehicles")
        }
        row = (
            connection.execute(
                sa.text(
                    "SELECT manufacturer, assigned_person_id, ctrack_vehicle_asset_id FROM vehicles"
                )
            )
            .mappings()
            .one()
        )
        connection.execute(
            sa.text(
                "INSERT INTO vehicles (id, license_plate, name, manufacturer) "
                "VALUES (2, 'OHZ-BE 2', 'Ford', 'Ford')"
            )
        )
        try:
            connection.execute(
                sa.text(
                    "INSERT INTO vehicles (id, license_plate, name, manufacturer) "
                    "VALUES (3, 'ohz-be 1', 'Doppelt', 'Doppelt')"
                )
            )
        except sa.exc.IntegrityError:
            duplicate_rejected = True
        else:
            duplicate_rejected = False

    assert columns["manufacturer"]["nullable"] is False
    assert row == {
        "manufacturer": "Volkswagen",
        "assigned_person_id": None,
        "ctrack_vehicle_asset_id": None,
    }
    assert duplicate_rejected is True
