import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260821_0100_add_project_photo_captions.py"
)
SPEC = importlib.util.spec_from_file_location("project_photo_captions_0100", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_project_photo_caption_migration_is_nullable_and_idempotent(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sites = sa.Table("sites", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(sites.insert().values(id=12))
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        connection.execute(
            sa.text(
                "INSERT INTO project_folder_document_captions "
                "(site_id, folder_key, external_item_id, caption) "
                "VALUES (12, 'fotos', 'photo-1', NULL)"
            )
        )
        MIGRATION.upgrade()

        inspector = sa.inspect(connection)
        columns = {
            column["name"]: column
            for column in inspector.get_columns("project_folder_document_captions")
        }
        rows = connection.execute(
            sa.text("SELECT external_item_id, caption FROM project_folder_document_captions")
        ).mappings().all()

    assert columns["caption"]["nullable"] is True
    assert rows == [{"external_item_id": "photo-1", "caption": None}]
