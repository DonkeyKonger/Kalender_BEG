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
    / "20260903_0108_add_payroll_daily_ledger.py"
)
SPEC = importlib.util.spec_from_file_location("payroll_daily_ledger_0108", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_payroll_daily_ledger_migration_preserves_and_tags_legacy_rows(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    persons = sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    users = sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    ledger = sa.Table(
        "person_hours_account_entries",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("entry_type", sa.String(40), nullable=False),
        sa.Column("minutes_delta", sa.Integer(), nullable=False),
        sa.Column("balance_after_minutes", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(persons.insert(), {"id": 1})
        connection.execute(users.insert(), {"id": 1})
        connection.execute(ledger.insert(), {
            "id": 1,
            "person_id": 1,
            "entry_type": "weekly_balance",
            "minutes_delta": 120,
            "balance_after_minutes": 120,
            "note": "Bestand",
        })
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        tables = set(inspector.get_table_names())
        ledger_columns = {
            column["name"] for column in inspector.get_columns("person_hours_account_entries")
        }
        ledger_indexes = {
            index["name"] for index in inspector.get_indexes("person_hours_account_entries")
        }
        legacy = connection.execute(sa.text(
            "SELECT ledger_system, effective_date, source_type, is_active "
            "FROM person_hours_account_entries WHERE id = 1"
        )).one()

        connection.execute(sa.text(
            "INSERT INTO person_weekly_schedules "
            "(person_id, valid_from, monday_minutes, tuesday_minutes, "
            "wednesday_minutes, thursday_minutes, friday_minutes, saturday_minutes, "
            "sunday_minutes, weekly_total_minutes, is_confirmed, created_at, updated_at) "
            "VALUES (1, '2026-08-01', 480, 480, 480, 480, 480, 0, 0, 2400, 0, "
            "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_weekly_schedules "
                "(person_id, valid_from, monday_minutes, tuesday_minutes, "
                "wednesday_minutes, thursday_minutes, friday_minutes, saturday_minutes, "
                "sunday_minutes, weekly_total_minutes, is_confirmed, created_at, updated_at) "
                "VALUES (1, '2026-08-01', 480, 480, 480, 480, 480, 0, 0, 2400, 0, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ))

        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_hours_opening_balances "
                "(person_id, as_of_date, balance_minutes, is_confirmed, created_at, updated_at) "
                "VALUES (1, '2026-08-01', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ))

        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_hours_account_entries "
                "(person_id, entry_type, minutes_delta, balance_after_minutes, note, "
                "ledger_system, effective_date, is_active) "
                "VALUES (1, 'manual_adjustment', 60, 60, 'ungueltig', "
                "'daily', NULL, 1)"
            ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_hours_account_entries "
                "(person_id, entry_type, minutes_delta, balance_after_minutes, note, "
                "ledger_system, effective_date, is_active) "
                "VALUES (1, 'manual_adjustment', 60, 60, 'ungueltig', "
                "'unbekannt', '2026-08-01', 1)"
            ))
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO person_hours_account_entries "
                "(person_id, entry_type, minutes_delta, balance_after_minutes, note, "
                "ledger_system, effective_date, is_active) "
                "VALUES (1, 'manual_adjustment', 60, 60, 'ungueltig', "
                "'daily', '2026-07-31', 1)"
            ))

    assert {"person_weekly_schedules", "person_hours_opening_balances"} <= tables
    assert {
        "ledger_system",
        "effective_date",
        "source_type",
        "source_reference_id",
        "idempotency_key",
        "is_active",
        "daily_target_minutes",
        "daily_work_minutes",
        "daily_credit_minutes",
        "daily_actual_minutes",
        "source_fingerprint",
        "source_payload",
    } <= ledger_columns
    assert {
        "uq_person_hours_account_entries_idempotency_key",
        "uq_person_hours_account_entries_active_daily",
    } <= ledger_indexes
    assert legacy == ("legacy", None, "weekly_balance", 1)
