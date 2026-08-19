import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260819_0098_add_extra_work_form_fields.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_form_0098", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_extra_work_form_migration_is_idempotent_and_preserves_legacy_ticket(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("display_number", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(
            tickets.insert(),
            {
                "id": 41,
                "site_id": 9,
                "display_number": "9999.SZ03",
                "status": "signed",
            },
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_tickets")
        }
        row = connection.execute(
            sa.text(
                "SELECT id, site_id, display_number, status, ordered_by_name, billing_type, "
                "manual_execution_start, manual_execution_end "
                "FROM extra_work_tickets WHERE id = 41"
            )
        ).mappings().one()

    expected_columns = {
        "ordered_by_name",
        "ordered_by_company",
        "billing_type",
        "estimated_order_value",
        "material_required",
        "material_separate_attachment",
        "executed_by_lead_monteur",
        "executed_by_monteur",
        "executed_by_helper",
        "executor_other_name",
        "work_description",
        "manual_execution_start",
        "manual_execution_end",
    }
    assert expected_columns <= set(columns)
    assert all(columns[name]["nullable"] for name in expected_columns)
    assert row == {
        "id": 41,
        "site_id": 9,
        "display_number": "9999.SZ03",
        "status": "signed",
        "ordered_by_name": None,
        "billing_type": None,
        "manual_execution_start": None,
        "manual_execution_end": None,
    }
