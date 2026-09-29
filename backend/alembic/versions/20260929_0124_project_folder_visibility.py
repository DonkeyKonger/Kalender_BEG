"""Per-site overrides for Monteur project folder access."""

from alembic import op
import sqlalchemy as sa

revision = "20260929_0124"
down_revision = "20260928_0123"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("project_folders", sa.Column("monteur_visibility_override", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("project_folders", "monteur_visibility_override")
