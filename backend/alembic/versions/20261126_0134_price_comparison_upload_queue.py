"""Add persistent price-comparison upload queue.

Revision ID: 20261126_0134
Revises: 20261116_0133
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20261126_0134"
down_revision: str | None = "20261116_0133"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "price_comparison_upload_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("client_request_id", sa.String(length=36), nullable=False),
        sa.Column("request_digest", sa.String(length=64), nullable=False),
        sa.Column("store_identity", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("file_names", sa.JSON(), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("total_bytes", sa.Integer(), nullable=False),
        sa.Column("duplicates", sa.JSON(), nullable=True),
        sa.Column("confirmation_revision", sa.String(length=64), nullable=True),
        sa.Column("confirmed_duplicates", sa.JSON(), nullable=True),
        sa.Column("result_revision", sa.String(length=64), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("worker_id", sa.String(length=160), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'processing', 'awaiting_confirmation', "
            "'completed', 'failed', 'cancelled')",
            name="ck_price_upload_jobs_status",
        ),
        sa.CheckConstraint("kind = 'offers'", name="ck_price_upload_jobs_kind"),
        sa.CheckConstraint("total_bytes > 0", name="ck_price_upload_jobs_total_bytes"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "created_by_user_id",
            "client_request_id",
            name="uq_price_upload_jobs_user_request",
        ),
    )
    op.create_index(
        "ix_price_upload_jobs_created_by_user_id",
        "price_comparison_upload_jobs",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_price_upload_jobs_status",
        "price_comparison_upload_jobs",
        ["status"],
    )
    op.create_index(
        "ix_price_upload_jobs_status_created",
        "price_comparison_upload_jobs",
        ["status", "created_at"],
    )
    op.create_table(
        "price_comparison_upload_files",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=220), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=True),
        sa.CheckConstraint("position >= 0", name="ck_price_upload_files_position"),
        sa.CheckConstraint("size > 0", name="ck_price_upload_files_size"),
        sa.ForeignKeyConstraint(
            ["job_id"], ["price_comparison_upload_jobs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "position", name="uq_price_upload_files_job_position"),
    )
    op.create_index(
        "ix_price_upload_files_job_id",
        "price_comparison_upload_files",
        ["job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_price_upload_files_job_id", table_name="price_comparison_upload_files")
    op.drop_table("price_comparison_upload_files")
    op.drop_index(
        "ix_price_upload_jobs_status_created",
        table_name="price_comparison_upload_jobs",
    )
    op.drop_index("ix_price_upload_jobs_status", table_name="price_comparison_upload_jobs")
    op.drop_index(
        "ix_price_upload_jobs_created_by_user_id",
        table_name="price_comparison_upload_jobs",
    )
    op.drop_table("price_comparison_upload_jobs")
