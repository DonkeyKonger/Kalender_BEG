import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260825_0103_add_extra_work_photo_thumbnails.py"
)
SPEC = importlib.util.spec_from_file_location("extra_work_photo_thumbnails_0103", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def test_extra_work_photo_thumbnail_migration_preserves_legacy_rows(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    photos = sa.Table(
        "extra_work_ticket_photos",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(photos.insert(), {"id": 1, "filename": "legacy.jpg"})
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION, "op", operations)

        MIGRATION.upgrade()
        MIGRATION.upgrade()

        columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("extra_work_ticket_photos")
        }
        legacy_row = connection.execute(
            sa.text(
                "SELECT filename, thumbnail_content, thumbnail_content_type "
                "FROM extra_work_ticket_photos WHERE id = 1"
            )
        ).mappings().one()

    assert columns["thumbnail_content"]["nullable"] is True
    assert columns["thumbnail_content_type"]["nullable"] is True
    assert columns["thumbnail_content_type"]["type"].length == 120
    assert legacy_row == {
        "filename": "legacy.jpg",
        "thumbnail_content": None,
        "thumbnail_content_type": None,
    }
