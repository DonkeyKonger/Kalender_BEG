import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


def load_migration():
    path = Path(__file__).parents[2] / "alembic/versions/20260905_0113_independent_manual_account_entries.py"
    spec = importlib.util.spec_from_file_location("manual_account_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("dialect", ["postgresql", "sqlite"])
def test_migration_changes_only_insert_exception_and_keeps_existing_guards(monkeypatch, dialect):
    migration = load_migration()
    statements = []
    monkeypatch.setattr(migration, "op", SimpleNamespace(
        get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name=dialect)), execute=statements.append))
    migration.upgrade()
    migration.downgrade()
    if dialect != "postgresql":
        assert statements == []
        return
    assert len(statements) == 2
    upgrade, downgrade = statements
    assert upgrade.replace(migration.MANUAL_INSERT_RULE, "") == downgrade
    assert "IF TG_OP = 'INSERT'" in migration.MANUAL_INSERT_RULE
    assert "NEW.entry_type IN ('manual_adjustment', 'payout')" in migration.MANUAL_INSERT_RULE
    assert "NEW.source_type = NEW.entry_type" in migration.MANUAL_INSERT_RULE
    assert "NEW.source_reference_id IS NULL" in migration.MANUAL_INSERT_RULE
    assert "NEW.weekly_review_id IS NULL" in migration.MANUAL_INSERT_RULE
    assert "FROM persons WHERE id = NEW.person_id FOR UPDATE" in migration.MANUAL_INSERT_RULE
    assert "payroll_assert_month_open" not in migration.MANUAL_INSERT_RULE
    for guard in ("payroll_assert_month_open(OLD.effective_date)",
                  "payroll_assert_person_month_open(OLD.person_id, OLD.effective_date)",
                  "payroll_assert_month_open(NEW.effective_date)",
                  "payroll_assert_person_month_open(NEW.person_id, NEW.effective_date)"):
        assert guard in upgrade and guard in downgrade
    assert "UPDATE person_hours_account_entries" not in upgrade
    assert "DELETE FROM" not in upgrade
