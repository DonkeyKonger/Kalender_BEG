"""Add measurement bases.

Revision ID: 20260527_0015
Revises: 20260526_0014
Create Date: 2026-05-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260527_0015"
down_revision: str | Sequence[str] | None = "20260526_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_measurement_bases",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("base_type", sa.String(length=40), nullable=True),
        sa.Column("status", sa.String(length=40), server_default="active", nullable=False),
        sa.Column("released_to_mobile", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("source_note", sa.Text(), nullable=True),
        sa.Column("import_label", sa.String(length=160), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_site_measurement_bases_site_id", "site_measurement_bases", ["site_id"])
    op.create_index("ix_site_measurement_bases_status", "site_measurement_bases", ["status"])

    op.add_column("site_measurement_items", sa.Column("measurement_base_id", sa.Integer(), nullable=True))
    op.add_column("site_measurement_batches", sa.Column("measurement_base_id", sa.Integer(), nullable=True))

    op.execute(
        """
        INSERT INTO site_measurement_bases
            (site_id, name, base_type, status, released_to_mobile, created_at, updated_at)
        SELECT DISTINCT site_id, 'Aufmaßbasis Bestand', 'mixed', 'active', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM (
            SELECT site_id FROM site_measurement_items
            UNION
            SELECT site_id FROM site_measurement_batches
        ) AS sites_with_measurements
        """
    )
    op.execute(
        """
        UPDATE site_measurement_items AS item
        SET measurement_base_id = base.id
        FROM site_measurement_bases AS base
        WHERE item.site_id = base.site_id
          AND item.measurement_base_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE site_measurement_batches AS batch
        SET measurement_base_id = base.id
        FROM site_measurement_bases AS base
        WHERE batch.site_id = base.site_id
          AND batch.measurement_base_id IS NULL
        """
    )

    op.create_foreign_key(
        "fk_site_measurement_items_measurement_base_id",
        "site_measurement_items",
        "site_measurement_bases",
        ["measurement_base_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_site_measurement_batches_measurement_base_id",
        "site_measurement_batches",
        "site_measurement_bases",
        ["measurement_base_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_site_measurement_items_measurement_base_id",
        "site_measurement_items",
        ["measurement_base_id"],
    )
    op.create_index(
        "ix_site_measurement_batches_measurement_base_id",
        "site_measurement_batches",
        ["measurement_base_id"],
    )
    op.alter_column("site_measurement_items", "measurement_base_id", nullable=False)
    op.alter_column("site_measurement_batches", "measurement_base_id", nullable=False)


def downgrade() -> None:
    op.drop_index("ix_site_measurement_batches_measurement_base_id", table_name="site_measurement_batches")
    op.drop_index("ix_site_measurement_items_measurement_base_id", table_name="site_measurement_items")
    op.drop_constraint(
        "fk_site_measurement_batches_measurement_base_id",
        "site_measurement_batches",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_site_measurement_items_measurement_base_id",
        "site_measurement_items",
        type_="foreignkey",
    )
    op.drop_column("site_measurement_batches", "measurement_base_id")
    op.drop_column("site_measurement_items", "measurement_base_id")
    op.drop_index("ix_site_measurement_bases_status", table_name="site_measurement_bases")
    op.drop_index("ix_site_measurement_bases_site_id", table_name="site_measurement_bases")
    op.drop_table("site_measurement_bases")
