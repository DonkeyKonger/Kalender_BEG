"""Add site measurement batches.

Revision ID: 20260526_0013
Revises: 20260526_0012
Create Date: 2026-05-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0013"
down_revision: str | None = "20260526_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_measurement_batches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="draft"),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("submitted_by_user_id", sa.Integer(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["submitted_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site_id", "number", name="uq_site_measurement_batches_site_number"),
    )
    op.create_index("ix_site_measurement_batches_site_id", "site_measurement_batches", ["site_id"])
    op.create_index("ix_site_measurement_batches_status", "site_measurement_batches", ["status"])
    op.create_index(
        "ix_site_measurement_batches_created_by_user_id",
        "site_measurement_batches",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_site_measurement_batches_submitted_by_user_id",
        "site_measurement_batches",
        ["submitted_by_user_id"],
    )

    op.add_column("site_measurement_entries", sa.Column("measurement_batch_id", sa.Integer(), nullable=True))

    # If the short-lived previous version already created loose entries, group them
    # into one draft batch per site so no entry remains without a package.
    op.execute(
        """
        INSERT INTO site_measurement_batches (site_id, number, title, status, created_at, updated_at)
        SELECT DISTINCT site_id, 1, 'Aufmaß 1', 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM site_measurement_entries
        WHERE site_id NOT IN (SELECT site_id FROM site_measurement_batches)
        """
    )
    op.execute(
        """
        UPDATE site_measurement_entries AS entry
        SET measurement_batch_id = batch.id
        FROM site_measurement_batches AS batch
        WHERE entry.site_id = batch.site_id
          AND batch.number = 1
          AND entry.measurement_batch_id IS NULL
        """
    )

    op.create_foreign_key(
        "fk_site_measurement_entries_measurement_batch_id",
        "site_measurement_entries",
        "site_measurement_batches",
        ["measurement_batch_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_site_measurement_entries_measurement_batch_id",
        "site_measurement_entries",
        ["measurement_batch_id"],
    )
    op.alter_column("site_measurement_entries", "measurement_batch_id", nullable=False)


def downgrade() -> None:
    op.drop_index("ix_site_measurement_entries_measurement_batch_id", table_name="site_measurement_entries")
    op.drop_constraint(
        "fk_site_measurement_entries_measurement_batch_id",
        "site_measurement_entries",
        type_="foreignkey",
    )
    op.drop_column("site_measurement_entries", "measurement_batch_id")
    op.drop_index("ix_site_measurement_batches_submitted_by_user_id", table_name="site_measurement_batches")
    op.drop_index("ix_site_measurement_batches_created_by_user_id", table_name="site_measurement_batches")
    op.drop_index("ix_site_measurement_batches_status", table_name="site_measurement_batches")
    op.drop_index("ix_site_measurement_batches_site_id", table_name="site_measurement_batches")
    op.drop_table("site_measurement_batches")
