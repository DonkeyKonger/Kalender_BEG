"""Add person-independent warehouse accounts.

The enum value is retained on downgrade to preserve existing warehouse accounts.
"""

from alembic import op

revision = "20260930_0125"
down_revision = "20260929_0124"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'warehouse'")
    op.create_check_constraint(
        "ck_warehouse_user_without_person", "users", "role <> 'warehouse' OR person_id IS NULL",
    )


def downgrade() -> None:
    op.drop_constraint("ck_warehouse_user_without_person", "users", type_="check")
