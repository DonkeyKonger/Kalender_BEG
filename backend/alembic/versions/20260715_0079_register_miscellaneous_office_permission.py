"""Register miscellaneous as an opt-in-only office page.

Revision ID: 20260715_0079
Revises: 20260715_0078
Create Date: 2026-07-15
"""

from collections.abc import Sequence
import json

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0079"
down_revision: str | None = "20260715_0078"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PERMISSION = "miscellaneous"


def upgrade() -> None:
    _remove_miscellaneous_permission()


def downgrade() -> None:
    _remove_miscellaneous_permission()


def _remove_miscellaneous_permission() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "users" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("users")}
    if not {"id", "office_page_permissions"}.issubset(columns):
        return

    users = sa.table(
        "users",
        sa.column("id", sa.Integer()),
        sa.column("office_page_permissions", sa.JSON()),
    )
    rows = connection.execute(
        sa.select(users.c.id, users.c.office_page_permissions)
    ).mappings().all()
    for row in rows:
        permissions = _permission_list(row["office_page_permissions"])
        cleaned_permissions = [permission for permission in permissions if permission != PERMISSION]
        if permissions != cleaned_permissions:
            connection.execute(
                users.update()
                .where(users.c.id == row["id"])
                .values(office_page_permissions=cleaned_permissions)
            )


def _permission_list(value) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
