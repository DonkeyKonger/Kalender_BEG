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
    / "20261005_0129_add_lost_tool_issue_reason.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("tool_issue_reason_0129", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_adds_lost_and_refuses_unsafe_downgrade(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    reports = sa.Table(
        "tool_issue_reports",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("reason", sa.String(9), nullable=False),
        sa.CheckConstraint(
            "reason IN ('DEFECTIVE', 'STOLEN')",
            name="tool_issue_reason",
        ),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(reports.insert().values(id=1, reason="DEFECTIVE"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()
        connection.execute(sa.text(
            "INSERT INTO tool_issue_reports (id, reason) VALUES (2, 'LOST')"
        ))
        with pytest.raises(RuntimeError, match="LOST"):
            MIGRATION_MODULE.downgrade()
        assert connection.scalar(sa.text(
            "SELECT reason FROM tool_issue_reports WHERE id = 2"
        )) == "LOST"

        connection.execute(sa.text("DELETE FROM tool_issue_reports WHERE id = 2"))
        MIGRATION_MODULE.downgrade()
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text(
                "INSERT INTO tool_issue_reports (id, reason) VALUES (3, 'LOST')"
            ))
        assert connection.scalar(sa.text(
            "SELECT reason FROM tool_issue_reports WHERE id = 1"
        )) == "DEFECTIVE"

