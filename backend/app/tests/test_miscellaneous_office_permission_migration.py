import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260715_0079_register_miscellaneous_office_permission.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location(
    "miscellaneous_office_permission_0079",
    MIGRATION_PATH,
)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_existing_users_do_not_receive_miscellaneous_permission(monkeypatch):
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    users = sa.Table(
        "users",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("role", sa.String(30), nullable=False),
        sa.Column("office_page_permissions", sa.JSON(), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            users.insert(),
            [
                {
                    "id": 1,
                    "role": "office",
                    "office_page_permissions": ["overview", "sites"],
                },
                {
                    "id": 2,
                    "role": "office",
                    "office_page_permissions": ["miscellaneous", "employees"],
                },
                {
                    "id": 3,
                    "role": "project_manager",
                    "office_page_permissions": ["miscellaneous"],
                },
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(MIGRATION_MODULE, "op", operations)

        MIGRATION_MODULE.upgrade()

        migrated = connection.execute(
            sa.select(users.c.id, users.c.office_page_permissions).order_by(users.c.id)
        ).mappings().all()

    assert migrated == [
        {"id": 1, "office_page_permissions": ["overview", "sites"]},
        {"id": 2, "office_page_permissions": ["employees"]},
        {"id": 3, "office_page_permissions": []},
    ]
