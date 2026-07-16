import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260716_0085_add_office_measurement_batches.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "office_measurement_batches_0085",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_marks_existing_measurements_as_legacy(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    batches = sa.Table(
        "site_measurement_batches",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(120), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(batches.insert().values(id=1, title="Historisches Aufmaß"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        inspector = sa.inspect(connection)
        columns = {
            column["name"]: column
            for column in inspector.get_columns("site_measurement_batches")
        }
        indexes = {
            index["name"]
            for index in inspector.get_indexes("site_measurement_batches")
        }
        constraints = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("site_measurement_batches")
        }
        migrated = connection.execute(
            sa.text(
                "SELECT id, title, origin, creator_role_at_creation, area_location, "
                "measurement_date, assigned_employee_id, request_id "
                "FROM site_measurement_batches"
            )
        ).mappings().one()

    assert columns["origin"]["nullable"] is False
    assert {
        "origin",
        "creator_role_at_creation",
        "area_location",
        "measurement_date",
        "assigned_employee_id",
        "request_id",
    } <= columns.keys()
    assert {
        "ix_site_measurement_batches_origin",
        "ix_site_measurement_batches_assigned_employee_id",
        "ix_site_measurement_batches_request_id",
    } <= indexes
    assert "measurement_batch_origin" in constraints
    assert migrated == {
        "id": 1,
        "title": "Historisches Aufmaß",
        "origin": "LEGACY",
        "creator_role_at_creation": None,
        "area_location": None,
        "measurement_date": None,
        "assigned_employee_id": None,
        "request_id": None,
    }
