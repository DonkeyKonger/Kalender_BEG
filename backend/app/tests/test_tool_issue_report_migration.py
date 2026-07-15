import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260715_0084_add_tool_issue_reports.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("tool_issue_reports_0084", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_adds_structured_report_table_without_changing_tools(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    users = sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    persons = sa.Table("persons", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    tools = sa.Table(
        "tool_material_items",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("designation", sa.String(240), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(users.insert(), [{"id": 1}, {"id": 2}])
        connection.execute(persons.insert().values(id=10))
        connection.execute(tools.insert().values(id=20, designation="Bestandsgerät"))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        inspector = sa.inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("tool_issue_reports")}
        indexes = {index["name"] for index in inspector.get_indexes("tool_issue_reports")}
        existing_tools = connection.execute(sa.text("SELECT id, designation FROM tool_material_items")).mappings().all()

    assert {
        "tool_id",
        "tool_id_snapshot",
        "reason",
        "status",
        "reporter_user_id",
        "reporter_employee_id",
        "reporter_last_name_snapshot",
        "recipient_user_id",
        "request_id",
        "created_at",
    } <= columns
    assert {
        "ix_tool_issue_reports_tool_status",
        "ix_tool_issue_reports_recipient_status",
        "ix_tool_issue_reports_created_at",
    } <= indexes
    assert existing_tools == [{"id": 20, "designation": "Bestandsgerät"}]
