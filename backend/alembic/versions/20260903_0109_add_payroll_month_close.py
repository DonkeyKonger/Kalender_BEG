"""Add immutable payroll month snapshots and retained export artifacts.

Revision ID: 20260903_0109
Revises: 20260903_0108
Create Date: 2026-09-03
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0109"
down_revision: str | None = "20260903_0108"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "time_entry_weekly_reviews",
        sa.Column("daily_ledger_reference_id", sa.String(length=120), nullable=True),
    )
    op.create_table(
        "payroll_month_periods",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="OPEN"),
        sa.Column("last_snapshot_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("row_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reopened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopened_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("year BETWEEN 2000 AND 2100", name="ck_payroll_month_periods_year"),
        sa.CheckConstraint("month BETWEEN 1 AND 12", name="ck_payroll_month_periods_month"),
        sa.CheckConstraint("status IN ('OPEN', 'LOCKED')", name="ck_payroll_month_periods_status"),
        sa.ForeignKeyConstraint(["locked_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reopened_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("year", "month", name="uq_payroll_month_periods_year_month"),
    )
    op.create_index("ix_payroll_month_periods_locked_by_user_id", "payroll_month_periods", ["locked_by_user_id"])
    op.create_index("ix_payroll_month_periods_reopened_by_user_id", "payroll_month_periods", ["reopened_by_user_id"])

    op.create_table(
        "payroll_month_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("reference_id", sa.String(length=100), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("cutover_date", sa.Date(), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["period_id"], ["payroll_month_periods.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period_id", "version", name="uq_payroll_month_snapshots_version"),
        sa.UniqueConstraint("reference_id", name="uq_payroll_month_snapshots_reference"),
    )
    op.create_index("ix_payroll_month_snapshots_period_id", "payroll_month_snapshots", ["period_id"])
    op.create_index("ix_payroll_month_snapshots_created_by_user_id", "payroll_month_snapshots", ["created_by_user_id"])
    op.create_index("ix_payroll_month_snapshots_period_created", "payroll_month_snapshots", ["period_id", "created_at"])

    op.create_table(
        "payroll_month_person_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("person_name", sa.String(length=240), nullable=False),
        sa.Column("opening_balance_minutes", sa.Integer(), nullable=False),
        sa.Column("movement_minutes", sa.Integer(), nullable=False),
        sa.Column("closing_balance_minutes", sa.Integer(), nullable=False),
        sa.Column("daily_values_json", sa.JSON(), nullable=False),
        sa.Column("source_sha256", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["payroll_month_snapshots.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("snapshot_id", "person_id", name="uq_payroll_month_person_snapshot"),
    )
    op.create_index("ix_payroll_month_person_snapshots_snapshot_id", "payroll_month_person_snapshots", ["snapshot_id"])
    op.create_index("ix_payroll_month_person_snapshots_person_id", "payroll_month_person_snapshots", ["person_id"])

    op.create_table(
        "payroll_month_artifacts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("artifact_key", sa.String(length=80), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=120), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["payroll_month_snapshots.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("snapshot_id", "artifact_key", name="uq_payroll_month_artifact_key"),
    )
    op.create_index("ix_payroll_month_artifacts_snapshot_id", "payroll_month_artifacts", ["snapshot_id"])
    op.create_index("ix_payroll_month_artifacts_person_id", "payroll_month_artifacts", ["person_id"])

    op.create_table(
        "payroll_month_audits",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("status_before", sa.String(length=16), nullable=False),
        sa.Column("status_after", sa.String(length=16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("details_json", sa.JSON(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["period_id"], ["payroll_month_periods.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["payroll_month_snapshots.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_payroll_month_audits_period_id", "payroll_month_audits", ["period_id"])
    op.create_index("ix_payroll_month_audits_snapshot_id", "payroll_month_audits", ["snapshot_id"])
    op.create_index("ix_payroll_month_audits_action", "payroll_month_audits", ["action"])
    op.create_index("ix_payroll_month_audits_user_id", "payroll_month_audits", ["user_id"])
    op.create_index("ix_payroll_month_audits_period_created", "payroll_month_audits", ["period_id", "created_at"])


def downgrade() -> None:
    op.drop_table("payroll_month_audits")
    op.drop_table("payroll_month_artifacts")
    op.drop_table("payroll_month_person_snapshots")
    op.drop_table("payroll_month_snapshots")
    op.drop_table("payroll_month_periods")
    op.drop_column("time_entry_weekly_reviews", "daily_ledger_reference_id")
