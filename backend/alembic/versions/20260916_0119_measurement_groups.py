"""Immutable combined measurements, outside the measurement quantity ledger."""
from alembic import op
import sqlalchemy as sa

revision = "20260916_0119"
down_revision = "20260914_0118"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("measurement_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number_label", sa.String(100), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("invalidated_at", sa.DateTime(timezone=True)),
        sa.Column("sources", sa.JSON(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("position_count", sa.Integer(), nullable=False),
        sa.Column("worker_signature_count", sa.Integer(), nullable=False),
        sa.Column("has_customer_signature", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_measurement_groups_site_id", "measurement_groups", ["site_id"])
    op.create_index("uq_measurement_group_active_number", "measurement_groups", ["site_id", "number_label"], unique=True,
                    postgresql_where=sa.text("invalidated_at IS NULL"), sqlite_where=sa.text("invalidated_at IS NULL"))
    op.create_table("measurement_group_members",
        sa.Column("group_id", sa.Integer(), sa.ForeignKey("measurement_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("active", sa.Boolean(), nullable=False))
    op.create_index("uq_measurement_group_active_batch", "measurement_group_members", ["batch_id"], unique=True,
                    postgresql_where=sa.text("active IS TRUE"), sqlite_where=sa.text("active IS TRUE"))


def downgrade():
    op.drop_table("measurement_group_members")
    op.drop_table("measurement_groups")
