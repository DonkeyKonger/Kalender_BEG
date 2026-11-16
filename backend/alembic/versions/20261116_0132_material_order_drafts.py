"""Add resumable per-user material order drafts."""

import sqlalchemy as sa
from alembic import op


revision = "20261116_0132"
down_revision = "20261102_0131"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "material_order_drafts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("values", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("filename", sa.String(length=255), nullable=True),
        sa.Column("completed_document", sa.JSON(), nullable=True),
        sa.Column("completion_token", sa.String(length=36), nullable=True),
        sa.Column("completion_filename", sa.String(length=255), nullable=True),
        sa.Column("completion_payload_revision", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("revision >= 0", name="ck_material_order_drafts_revision"),
        sa.CheckConstraint(
            "status IN ('draft', 'completed')",
            name="ck_material_order_drafts_status",
        ),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_material_order_drafts_site_id",
        "material_order_drafts",
        ["site_id"],
    )
    op.create_index(
        "ix_material_order_drafts_user_id",
        "material_order_drafts",
        ["user_id"],
    )
    op.create_index(
        "ix_material_order_drafts_status",
        "material_order_drafts",
        ["status"],
    )
    op.create_index(
        "uq_material_order_drafts_open_site_user",
        "material_order_drafts",
        ["site_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'draft'"),
        sqlite_where=sa.text("status = 'draft'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_material_order_drafts_open_site_user",
        table_name="material_order_drafts",
    )
    op.drop_index("ix_material_order_drafts_status", table_name="material_order_drafts")
    op.drop_index("ix_material_order_drafts_user_id", table_name="material_order_drafts")
    op.drop_index("ix_material_order_drafts_site_id", table_name="material_order_drafts")
    op.drop_table("material_order_drafts")
