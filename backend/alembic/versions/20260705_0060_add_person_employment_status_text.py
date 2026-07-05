"""Persist person employment status as text.

Revision ID: 20260705_0060
Revises: 20260705_0059
Create Date: 2026-07-05
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260705_0060"
down_revision: str | None = "20260705_0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "employment_status" not in columns:
        op.add_column(
            "persons",
            sa.Column("employment_status", sa.String(length=20), nullable=False, server_default="active"),
        )
    op.execute(
        sa.text(
            """
            UPDATE persons
            SET employment_status = CASE
                WHEN employment_status IS NULL OR employment_status = ''
                    THEN CASE WHEN is_active THEN 'active' ELSE 'departed' END
                ELSE employment_status
            END
            """
        )
    )


def downgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "employment_status" in columns:
        op.drop_column("persons", "employment_status")
