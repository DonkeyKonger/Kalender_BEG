"""Add person employment status.

Revision ID: 20260705_0058
Revises: 20260704_0057
Create Date: 2026-07-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260705_0058"
down_revision: str | None = "20260704_0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


person_employment_status = postgresql.ENUM(
    "active",
    "paused",
    "departed",
    name="person_employment_status",
    create_type=False,
)


def _status_column_type():
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        person_employment_status.create(bind, checkfirst=True)
        return person_employment_status
    return sa.String(length=20)


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "employment_status",
            _status_column_type(),
            nullable=False,
            server_default="active",
        ),
    )
    op.execute(
        "UPDATE persons SET employment_status = CASE WHEN is_active THEN 'active' ELSE 'departed' END",
    )


def downgrade() -> None:
    op.drop_column("persons", "employment_status")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        person_employment_status.drop(bind, checkfirst=True)
