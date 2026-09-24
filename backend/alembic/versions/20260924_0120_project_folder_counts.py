"""Persist last known recursive file counts independently of SharePoint latency."""
from alembic import op
import sqlalchemy as sa

revision = "20260924_0120"
down_revision = "20260916_0119"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("project_folder_counts",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("file_count", sa.Integer()),
        sa.Column("checked_at", sa.Float()),
        sa.Column("retry_after", sa.Float(), nullable=False, server_default="0"),
        sa.Column("token", sa.String(36)))
    op.create_index("ix_project_folder_counts_site_id", "project_folder_counts", ["site_id"])


def downgrade():
    op.drop_table("project_folder_counts")
