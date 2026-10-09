"""Keep deleted customer contacts out of aggregated project email suggestions."""

import sqlalchemy as sa
from alembic import op

revision = "20261009_0130"
down_revision = "20261005_0129"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("excluded_contact_emails", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("customers", "excluded_contact_emails")
