import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260818_0097_add_extra_work_ticket_archive_fields.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_archive_0097", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_extra_work_archive_migration_preserves_existing_tickets(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    users = sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    tickets = sa.Table(
        "extra_work_tickets",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column("display_number", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(users.insert(), {"id": 7})
        connection.execute(
            tickets.insert(),
            {
                "id": 41,
                "site_id": 9,
                "sequence_number": 3,
                "display_number": "9999-003",
                "status": "signed",
            },
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        columns = {
            column["name"]: column
            for column in inspector.get_columns("extra_work_tickets")
        }
        indexes = {
            index["name"]
            for index in inspector.get_indexes("extra_work_tickets")
        }
        foreign_keys = {
            foreign_key["name"]: foreign_key
            for foreign_key in inspector.get_foreign_keys("extra_work_tickets")
        }
        row = connection.execute(
            sa.text(
                "SELECT id, display_number, status, deleted_at, deleted_by_user_id "
                "FROM extra_work_tickets WHERE id = 41"
            )
        ).mappings().one()

        MIGRATION.downgrade()
        columns_after_downgrade = {
            column["name"]
            for column in sa.inspect(connection).get_columns("extra_work_tickets")
        }

    assert columns["deleted_at"]["nullable"] is True
    assert columns["deleted_by_user_id"]["nullable"] is True
    assert "ix_extra_work_tickets_deleted_at" in indexes
    assert "ix_extra_work_tickets_deleted_by_user_id" in indexes
    assert foreign_keys["fk_extra_work_tickets_deleted_by_user_id"]["referred_table"] == "users"
    assert row == {
        "id": 41,
        "display_number": "9999-003",
        "status": "signed",
        "deleted_at": None,
        "deleted_by_user_id": None,
    }
    assert "deleted_at" not in columns_after_downgrade
    assert "deleted_by_user_id" not in columns_after_downgrade
