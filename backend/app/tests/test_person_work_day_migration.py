import importlib.util
from datetime import date
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260817_0096_add_person_work_day_overnight_status.py"
)
SPEC = importlib.util.spec_from_file_location("person_work_day_0096", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_person_work_day_migration_preserves_history_and_enforces_daily_status(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    persons = sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    work_entries = sa.Table(
        "work_time_entries",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("work_date", sa.Date(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(persons.insert(), {"id": 1})
        connection.execute(
            work_entries.insert(),
            {"id": 1, "person_id": 1, "work_date": date(2026, 8, 1)},
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        columns = {
            column["name"]: column
            for column in inspector.get_columns("person_work_days")
        }
        unique_constraints = {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("person_work_days")
        }
        check_constraints = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("person_work_days")
        }
        historical_day_count = connection.execute(
            sa.text("SELECT COUNT(*) FROM person_work_days")
        ).scalar_one()

        connection.execute(sa.text(
            "INSERT INTO person_work_days (person_id, work_date, overnight_status) "
            "VALUES (1, '2026-08-01', NULL)"
        ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_work_days (person_id, work_date, overnight_status) "
                "VALUES (1, '2026-08-01', 'none')"
            ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_work_days (person_id, work_date, overnight_status) "
                "VALUES (1, '2026-08-02', 'invalid')"
            ))

        MIGRATION.downgrade()
        tables_after_downgrade = set(sa.inspect(connection).get_table_names())

    assert columns["overnight_status"]["nullable"] is True
    assert historical_day_count == 0
    assert "uq_person_work_days_person_date" in unique_constraints
    assert "ck_person_work_days_overnight_status" in check_constraints
    assert "person_work_days" not in tables_after_downgrade
