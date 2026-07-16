"""Add traceable desktop-created measurement batches.

Revision ID: 20260716_0085
Revises: 20260715_0084
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260716_0085"
down_revision: str | None = "20260715_0084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("site_measurement_batches")
    }
    with op.batch_alter_table("site_measurement_batches") as batch_op:
        if "origin" not in columns:
            batch_op.add_column(
                sa.Column("origin", sa.String(length=20), server_default="LEGACY", nullable=False)
            )
        if "creator_role_at_creation" not in columns:
            batch_op.add_column(sa.Column("creator_role_at_creation", sa.String(length=40)))
        if "area_location" not in columns:
            batch_op.add_column(sa.Column("area_location", sa.String(length=260)))
        if "measurement_date" not in columns:
            batch_op.add_column(sa.Column("measurement_date", sa.Date()))
        if "assigned_employee_id" not in columns:
            batch_op.add_column(sa.Column("assigned_employee_id", sa.Integer()))
            batch_op.create_foreign_key(
                "fk_measurement_batches_assigned_employee",
                "persons",
                ["assigned_employee_id"],
                ["id"],
                ondelete="SET NULL",
            )
        if "request_id" not in columns:
            batch_op.add_column(sa.Column("request_id", sa.String(length=64)))
        batch_op.create_check_constraint(
            "measurement_batch_origin",
            "origin IN ('MONTEUR', 'OFFICE', 'LEGACY')",
        )
        batch_op.create_unique_constraint(
            "uq_site_measurement_batches_request_id",
            ["request_id"],
        )

    op.create_index(
        "ix_site_measurement_batches_origin",
        "site_measurement_batches",
        ["origin"],
    )
    op.create_index(
        "ix_site_measurement_batches_assigned_employee_id",
        "site_measurement_batches",
        ["assigned_employee_id"],
    )
    op.create_index(
        "ix_site_measurement_batches_request_id",
        "site_measurement_batches",
        ["request_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_site_measurement_batches_request_id", table_name="site_measurement_batches")
    op.drop_index(
        "ix_site_measurement_batches_assigned_employee_id",
        table_name="site_measurement_batches",
    )
    op.drop_index("ix_site_measurement_batches_origin", table_name="site_measurement_batches")
    with op.batch_alter_table("site_measurement_batches") as batch_op:
        batch_op.drop_constraint("uq_site_measurement_batches_request_id", type_="unique")
        batch_op.drop_constraint("measurement_batch_origin", type_="check")
        batch_op.drop_constraint("fk_measurement_batches_assigned_employee", type_="foreignkey")
        batch_op.drop_column("request_id")
        batch_op.drop_column("assigned_employee_id")
        batch_op.drop_column("measurement_date")
        batch_op.drop_column("area_location")
        batch_op.drop_column("creator_role_at_creation")
        batch_op.drop_column("origin")
