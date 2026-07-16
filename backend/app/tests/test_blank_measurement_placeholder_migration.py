import importlib.util
from pathlib import Path

from sqlalchemy import create_engine, text


MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "20260716_0087_remove_empty_blank_measurement_items.py"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location("blank_measurement_placeholder_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_removes_only_empty_generated_blank_positions():
    migration = load_migration_module()
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE site_measurement_batches (id INTEGER PRIMARY KEY, position_mode TEXT NOT NULL)"))
        connection.execute(
            text(
                "CREATE TABLE site_measurement_items ("
                "id INTEGER PRIMARY KEY, measurement_batch_id INTEGER, is_free_position BOOLEAN NOT NULL, "
                "position TEXT NOT NULL, description TEXT NOT NULL, unit TEXT)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE site_measurement_entries ("
                "id INTEGER PRIMARY KEY, measurement_item_id INTEGER NOT NULL)"
            )
        )
        connection.execute(
            text("INSERT INTO site_measurement_batches (id, position_mode) VALUES (1, 'BLANK'), (2, 'OFFER_BASED')")
        )
        connection.execute(
            text(
                "INSERT INTO site_measurement_items "
                "(id, measurement_batch_id, is_free_position, position, description, unit) VALUES "
                "(10, 1, TRUE, 'FREI-1', '', 'st'), "
                "(11, 1, TRUE, 'A-1', '', 'st'), "
                "(12, 1, TRUE, 'FREI-2', 'Echte Leistung', 'm'), "
                "(13, 1, TRUE, 'FREI-3', '', 'st'), "
                "(14, 2, TRUE, 'FREI-1', '', 'st')"
            )
        )
        connection.execute(text("INSERT INTO site_measurement_entries (id, measurement_item_id) VALUES (1, 13)"))

        removed = migration._remove_empty_placeholder_items(connection)
        remaining_ids = connection.execute(text("SELECT id FROM site_measurement_items ORDER BY id")).scalars().all()

    assert removed == 1
    assert remaining_ids == [11, 12, 13, 14]
