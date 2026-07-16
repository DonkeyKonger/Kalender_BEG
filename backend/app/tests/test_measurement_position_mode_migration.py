import importlib.util
from pathlib import Path

from sqlalchemy import create_engine, text


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260716_0086_add_measurement_position_mode.py"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location("measurement_position_mode_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_only_converts_unambiguously_empty_office_drafts():
    migration = load_migration_module()
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE site_measurement_batches (
                    id INTEGER PRIMARY KEY,
                    origin TEXT NOT NULL,
                    status TEXT NOT NULL,
                    submitted_at TEXT,
                    original_submitted_snapshot TEXT,
                    customer_signed_at TEXT,
                    customer_signed_snapshot TEXT,
                    worker_signed_at TEXT,
                    position_mode TEXT NOT NULL,
                    measurement_base_id INTEGER
                )
                """
            )
        )
        connection.execute(
            text(
                "CREATE TABLE site_measurement_entries (id INTEGER PRIMARY KEY, measurement_batch_id INTEGER)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE site_measurement_items (id INTEGER PRIMARY KEY, measurement_batch_id INTEGER)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE site_measurement_area_rows (id INTEGER PRIMARY KEY, measurement_batch_id INTEGER)"
            )
        )
        connection.execute(
            text(
                """
                INSERT INTO site_measurement_batches
                    (id, origin, status, position_mode, measurement_base_id)
                VALUES
                    (1, 'OFFICE', 'draft', 'OFFER_BASED', 10),
                    (2, 'OFFICE', 'draft', 'OFFER_BASED', 10),
                    (3, 'OFFICE', 'billed', 'OFFER_BASED', 10),
                    (4, 'MONTEUR', 'draft', 'OFFER_BASED', 10)
                """
            )
        )
        connection.execute(
            text("INSERT INTO site_measurement_area_rows (id, measurement_batch_id) VALUES (1, 1)")
        )
        connection.execute(
            text("INSERT INTO site_measurement_items (id, measurement_batch_id) VALUES (1, 2)")
        )

        converted_ids = migration._convert_safe_empty_office_batches(connection)

        assert converted_ids == [1]
        rows = connection.execute(
            text(
                "SELECT id, position_mode, measurement_base_id "
                "FROM site_measurement_batches ORDER BY id"
            )
        ).all()
        assert rows == [
            (1, "BLANK", None),
            (2, "OFFER_BASED", 10),
            (3, "OFFER_BASED", 10),
            (4, "OFFER_BASED", 10),
        ]
        assert connection.scalar(text("SELECT COUNT(*) FROM site_measurement_area_rows")) == 0
