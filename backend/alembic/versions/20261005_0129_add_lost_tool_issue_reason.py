"""Allow lost as a distinct tool issue reason.

Revision ID: 20261005_0129
Revises: 20261005_0128
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20261005_0129"
down_revision: str | None = "20261005_0128"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE_NAME = "tool_issue_reports"
CONSTRAINT_NAME = "tool_issue_reason"


def upgrade() -> None:
    _replace_reason_constraint(("DEFECTIVE", "LOST", "STOLEN"))


def downgrade() -> None:
    connection = op.get_bind()
    if TABLE_NAME not in sa.inspect(connection).get_table_names():
        return
    lost_count = connection.scalar(
        sa.text("SELECT COUNT(*) FROM tool_issue_reports WHERE reason = 'LOST'")
    )
    if lost_count:
        raise RuntimeError(
            "Downgrade nicht möglich: Es sind Werkzeugmeldungen mit dem Grund LOST vorhanden."
        )
    _replace_reason_constraint(("DEFECTIVE", "STOLEN"))


def _replace_reason_constraint(values: tuple[str, ...]) -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if "reason" not in columns:
        return
    constraints = {
        constraint["name"]
        for constraint in inspector.get_check_constraints(TABLE_NAME)
    }
    allowed = ", ".join(f"'{value}'" for value in values)
    with op.batch_alter_table(TABLE_NAME) as batch_op:
        if CONSTRAINT_NAME in constraints:
            batch_op.drop_constraint(CONSTRAINT_NAME, type_="check")
        batch_op.create_check_constraint(CONSTRAINT_NAME, f"reason IN ({allowed})")
