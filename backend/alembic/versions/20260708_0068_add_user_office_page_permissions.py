"""Add office page permissions to users.

Revision ID: 20260708_0068
Revises: 20260708_0067
Create Date: 2026-07-08
"""

from collections.abc import Sequence
import json

from alembic import op
import sqlalchemy as sa


revision: str = "20260708_0068"
down_revision: str | None = "20260708_0067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


DEFAULT_OFFICE_PAGE_PERMISSIONS = [
    "overview",
    "calendar",
    "absences",
    "sites",
    "map",
    "payroll",
    "export",
]


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "users" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("users")
    }
    if "office_page_permissions" not in columns:
        op.add_column("users", sa.Column("office_page_permissions", sa.JSON(), nullable=True))

    office_permissions = json.dumps(DEFAULT_OFFICE_PAGE_PERMISSIONS)
    empty_permissions = json.dumps([])
    if connection.dialect.name == "postgresql":
        connection.execute(
            sa.text(
                "UPDATE users "
                "SET office_page_permissions = CAST(:permissions AS JSON) "
                "WHERE role = 'office' AND office_page_permissions IS NULL"
            ),
            {"permissions": office_permissions},
        )
        connection.execute(
            sa.text(
                "UPDATE users "
                "SET office_page_permissions = CAST(:permissions AS JSON) "
                "WHERE office_page_permissions IS NULL"
            ),
            {"permissions": empty_permissions},
        )
    else:
        connection.execute(
            sa.text(
                "UPDATE users "
                "SET office_page_permissions = :permissions "
                "WHERE role = 'office' AND office_page_permissions IS NULL"
            ),
            {"permissions": office_permissions},
        )
        connection.execute(
            sa.text(
                "UPDATE users "
                "SET office_page_permissions = :permissions "
                "WHERE office_page_permissions IS NULL"
            ),
            {"permissions": empty_permissions},
        )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "users" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("users")
    }
    if "office_page_permissions" in columns:
        op.drop_column("users", "office_page_permissions")
