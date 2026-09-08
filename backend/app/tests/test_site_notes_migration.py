import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_note_migration_preserves_existing_general_notes():
    path = Path(__file__).parents[2] / "alembic/versions/20260908_0115_project_note_categories.py"
    spec = importlib.util.spec_from_file_location("project_note_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE sites (id INTEGER PRIMARY KEY, info TEXT)"))
        connection.execute(text("INSERT INTO sites (id, info) VALUES (1, 'Bestehende allgemeine Notiz')"))
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.scalar(text("SELECT info FROM sites WHERE id = 1")) == "Bestehende allgemeine Notiz"
        assert set(inspect(connection).get_table_names()) == {"sites", "site_internal_notes", "site_note_blocks"}
        connection.execute(text("INSERT INTO site_internal_notes (site_id, content, revision) VALUES (1, 'Intern', 1)"))
        connection.execute(text("INSERT INTO site_note_blocks (site_id, number, title, content, visible_to_workers, revision) VALUES (1, 1, 'Stand 1', 'Inhalt', 0, 1)"))
        assert connection.scalar(text("SELECT visible_to_workers FROM site_note_blocks")) == 0
