import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20261126_0134_price_comparison_upload_queue.py"
)
SPEC = importlib.util.spec_from_file_location("price_upload_queue_0134", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_price_upload_queue_migration_creates_persistent_payload_and_scope(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        monkeypatch.setattr(MIGRATION, "op", Operations(MigrationContext.configure(connection)))
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        job_columns = {
            column["name"] for column in inspector.get_columns("price_comparison_upload_jobs")
        }
        file_columns = {
            column["name"] for column in inspector.get_columns("price_comparison_upload_files")
        }
        unique_names = {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("price_comparison_upload_jobs")
        }

        assert {"client_request_id", "request_digest", "store_identity"} <= job_columns
        assert {"sha256", "payload"} <= file_columns
        assert "uq_price_upload_jobs_user_request" in unique_names

        MIGRATION.downgrade()
        assert "price_comparison_upload_jobs" not in inspector.get_table_names()
