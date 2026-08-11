import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260811_0094_add_operational_absences.py"
)
SPEC = importlib.util.spec_from_file_location("operational_absences_0094", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_operational_absence_migration_creates_separate_indexed_validated_table(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("sites", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        columns = {
            column["name"]: column
            for column in inspector.get_columns("operational_absences")
        }
        indexes = {
            index["name"]
            for index in inspector.get_indexes("operational_absences")
        }
        constraints = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("operational_absences")
        }
        tables = set(inspector.get_table_names())

    assert "operational_absences" in tables
    assert {
        "id",
        "project_manager_id",
        "absence_date",
        "start_time",
        "end_time",
        "site_id",
        "text",
        "created_by_user_id",
        "created_at",
        "updated_at",
    } == columns.keys()
    assert columns["project_manager_id"]["nullable"] is False
    assert columns["absence_date"]["nullable"] is False
    assert "ix_operational_absences_date_project_manager" in indexes
    assert "ck_operational_absences_time_range" in constraints
