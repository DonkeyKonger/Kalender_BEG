import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
import sqlalchemy as sa


def test_monthly_account_migration_preserves_history_and_allows_unknown_values(monkeypatch):
    path = Path(__file__).parents[2] / "alembic/versions/20260905_0112_monthly_hours_account.py"
    spec = importlib.util.spec_from_file_location("monthly_account_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    ledger = sa.Table("person_hours_account_entries", metadata,
                      sa.Column("id", sa.Integer(), primary_key=True),
                      sa.Column("person_id", sa.Integer(), nullable=False),
                      sa.Column("entry_type", sa.String(), nullable=False),
                      sa.Column("effective_date", sa.Date()),
                      sa.Column("is_active", sa.Boolean(), nullable=False),
                      sa.Column("balance_after_minutes", sa.Integer(), nullable=False))
    snapshots = sa.Table("payroll_month_person_snapshots", metadata,
                         sa.Column("id", sa.Integer(), primary_key=True),
                         *(sa.Column(name, sa.Integer(), nullable=False) for name in
                           ("opening_balance_minutes", "movement_minutes", "closing_balance_minutes")))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(ledger.insert(), dict(id=1, person_id=2, entry_type="weekly_balance",
                                                 is_active=True, balance_after_minutes=-30))
        connection.execute(snapshots.insert(), dict(id=1, opening_balance_minutes=100,
                                                    movement_minutes=-30, closing_balance_minutes=70))
        before_ledger = connection.execute(sa.select(ledger)).all()
        before_snapshots = connection.execute(sa.select(snapshots)).all()
        monkeypatch.setattr(module, "op", Operations(MigrationContext.configure(connection)))
        module.upgrade()
        assert connection.execute(sa.select(ledger)).all() == before_ledger
        assert connection.execute(sa.select(snapshots)).all() == before_snapshots
        assert "uq_person_hours_account_entries_active_month" in {
            index["name"] for index in sa.inspect(connection).get_indexes(ledger.name)}
        connection.execute(ledger.insert(), dict(id=2, person_id=3, entry_type="monthly_transition",
                                                 is_active=True, balance_after_minutes=None))
        connection.execute(snapshots.insert(), dict(id=2, opening_balance_minutes=None,
                                                    movement_minutes=120, closing_balance_minutes=None))
        with pytest.raises(RuntimeError, match="lossless downgrade"):
            module.downgrade()
        assert connection.execute(sa.select(ledger)).all()[0] == before_ledger[0]
