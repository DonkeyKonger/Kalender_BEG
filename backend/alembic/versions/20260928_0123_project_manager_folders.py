"""Persist project manager OneDrive folder identities."""
from alembic import op
import sqlalchemy as sa

revision = "20260928_0123"
down_revision = "20260925_0122"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "project_manager_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("person_id", sa.Integer(), sa.ForeignKey("persons.id"), nullable=False),
        sa.Column("drive_id", sa.String(255), nullable=False),
        sa.Column("parent_folder_id", sa.String(255), nullable=False),
        sa.Column("folder_id", sa.String(255), nullable=False),
        sa.UniqueConstraint("person_id", "drive_id", "parent_folder_id", name="uq_manager_folder_scope"),
        sa.UniqueConstraint("drive_id", "folder_id", name="uq_manager_folder_item"),
    )
    op.create_index("ix_project_manager_folders_person_id", "project_manager_folders", ["person_id"])


def downgrade():
    op.drop_table("project_manager_folders")
