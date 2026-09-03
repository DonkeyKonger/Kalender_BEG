"""Add confirmed payroll schedules, opening balances and daily ledger metadata.

Revision ID: 20260903_0108
Revises: 20260831_0107
Create Date: 2026-09-03
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0108"
down_revision: str | None = "20260831_0107"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SCHEDULE_TABLE = "person_weekly_schedules"
OPENING_TABLE = "person_hours_opening_balances"
LEDGER_TABLE = "person_hours_account_entries"


LEDGER_COLUMNS = {
    "ledger_system": sa.Column(
        "ledger_system", sa.String(length=20), nullable=False, server_default="legacy"
    ),
    "effective_date": sa.Column("effective_date", sa.Date(), nullable=True),
    "source_type": sa.Column("source_type", sa.String(length=40), nullable=True),
    "source_reference_id": sa.Column(
        "source_reference_id", sa.String(length=120), nullable=True
    ),
    "idempotency_key": sa.Column("idempotency_key", sa.String(length=255), nullable=True),
    "is_active": sa.Column(
        "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
    ),
    "superseded_at": sa.Column(
        "superseded_at", sa.DateTime(timezone=True), nullable=True
    ),
    "daily_target_minutes": sa.Column("daily_target_minutes", sa.Integer(), nullable=True),
    "daily_work_minutes": sa.Column("daily_work_minutes", sa.Integer(), nullable=True),
    "daily_credit_minutes": sa.Column("daily_credit_minutes", sa.Integer(), nullable=True),
    "daily_actual_minutes": sa.Column("daily_actual_minutes", sa.Integer(), nullable=True),
    "daily_absence_type": sa.Column(
        "daily_absence_type", sa.String(length=40), nullable=True
    ),
    "source_fingerprint": sa.Column(
        "source_fingerprint", sa.String(length=64), nullable=True
    ),
    "source_payload": sa.Column("source_payload", sa.JSON(), nullable=True),
}


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())

    if SCHEDULE_TABLE not in tables:
        op.create_table(
            SCHEDULE_TABLE,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("person_id", sa.Integer(), nullable=False),
            sa.Column("valid_from", sa.Date(), nullable=False),
            sa.Column("valid_until", sa.Date(), nullable=True),
            sa.Column("monday_minutes", sa.Integer(), nullable=False),
            sa.Column("tuesday_minutes", sa.Integer(), nullable=False),
            sa.Column("wednesday_minutes", sa.Integer(), nullable=False),
            sa.Column("thursday_minutes", sa.Integer(), nullable=False),
            sa.Column("friday_minutes", sa.Integer(), nullable=False),
            sa.Column("saturday_minutes", sa.Integer(), nullable=False),
            sa.Column("sunday_minutes", sa.Integer(), nullable=False),
            sa.Column("weekly_total_minutes", sa.Integer(), nullable=False),
            sa.Column("contract_weekly_minutes", sa.Integer(), nullable=True),
            sa.Column("is_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), nullable=True),
            sa.Column("confirmed_by_user_id", sa.Integer(), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.CheckConstraint(
                "valid_until IS NULL OR valid_until >= valid_from",
                name="ck_person_weekly_schedules_date_range",
            ),
            sa.CheckConstraint(
                "monday_minutes >= 0 AND tuesday_minutes >= 0 "
                "AND wednesday_minutes >= 0 AND thursday_minutes >= 0 "
                "AND friday_minutes >= 0 AND saturday_minutes >= 0 "
                "AND sunday_minutes >= 0",
                name="ck_person_weekly_schedules_nonnegative",
            ),
            sa.CheckConstraint(
                "weekly_total_minutes = monday_minutes + tuesday_minutes "
                "+ wednesday_minutes + thursday_minutes + friday_minutes "
                "+ saturday_minutes + sunday_minutes",
                name="ck_person_weekly_schedules_total",
            ),
            sa.CheckConstraint(
                "(is_confirmed = false AND confirmed_at IS NULL "
                "AND confirmed_by_user_id IS NULL) OR "
                "(is_confirmed = true AND confirmed_at IS NOT NULL "
                "AND confirmed_by_user_id IS NOT NULL)",
                name="ck_person_weekly_schedules_confirmation",
            ),
            sa.ForeignKeyConstraint(
                ["person_id"], ["persons.id"], ondelete="RESTRICT"
            ),
            sa.ForeignKeyConstraint(
                ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["confirmed_by_user_id"], ["users.id"], ondelete="RESTRICT"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "person_id",
                "valid_from",
                name="uq_person_weekly_schedules_person_start",
            ),
        )
        op.create_index(
            "ix_person_weekly_schedules_person_id", SCHEDULE_TABLE, ["person_id"]
        )
        op.create_index(
            "ix_person_weekly_schedules_created_by_user_id",
            SCHEDULE_TABLE,
            ["created_by_user_id"],
        )
        op.create_index(
            "ix_person_weekly_schedules_confirmed_by_user_id",
            SCHEDULE_TABLE,
            ["confirmed_by_user_id"],
        )
        op.create_index(
            "ix_person_weekly_schedules_person_validity",
            SCHEDULE_TABLE,
            ["person_id", "valid_from", "valid_until"],
        )

    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    if OPENING_TABLE not in tables:
        op.create_table(
            OPENING_TABLE,
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("person_id", sa.Integer(), nullable=False),
            sa.Column(
                "as_of_date", sa.Date(), nullable=False, server_default="2026-07-31"
            ),
            sa.Column("balance_minutes", sa.Integer(), nullable=False),
            sa.Column(
                "entry_type",
                sa.String(length=40),
                nullable=False,
                server_default="legacy_opening_balance",
            ),
            sa.Column("is_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), nullable=True),
            sa.Column("confirmed_by_user_id", sa.Integer(), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.CheckConstraint(
                "as_of_date = '2026-07-31'",
                name="ck_person_hours_opening_balances_cutover_date",
            ),
            sa.CheckConstraint(
                "(is_confirmed = false AND confirmed_at IS NULL "
                "AND confirmed_by_user_id IS NULL) OR "
                "(is_confirmed = true AND confirmed_at IS NOT NULL "
                "AND confirmed_by_user_id IS NOT NULL)",
                name="ck_person_hours_opening_balances_confirmation",
            ),
            sa.ForeignKeyConstraint(
                ["person_id"], ["persons.id"], ondelete="RESTRICT"
            ),
            sa.ForeignKeyConstraint(
                ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
            ),
            sa.ForeignKeyConstraint(
                ["confirmed_by_user_id"], ["users.id"], ondelete="RESTRICT"
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "person_id",
                "as_of_date",
                name="uq_person_hours_opening_balances_person_date",
            ),
        )
        op.create_index(
            "ix_person_hours_opening_balances_person_id", OPENING_TABLE, ["person_id"]
        )
        op.create_index(
            "ix_person_hours_opening_balances_created_by_user_id",
            OPENING_TABLE,
            ["created_by_user_id"],
        )
        op.create_index(
            "ix_person_hours_opening_balances_confirmed_by_user_id",
            OPENING_TABLE,
            ["confirmed_by_user_id"],
        )

    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    if LEDGER_TABLE not in tables:
        return

    columns = {column["name"] for column in inspector.get_columns(LEDGER_TABLE)}
    for column_name, column in LEDGER_COLUMNS.items():
        if column_name not in columns:
            op.add_column(LEDGER_TABLE, column)

    # Every pre-existing row belongs to the preserved legacy calculation.  No
    # effective date is invented during migration.
    op.execute(sa.text(
        "UPDATE person_hours_account_entries "
        "SET ledger_system = 'legacy' "
        "WHERE ledger_system IS NULL OR ledger_system = ''"
    ))
    op.execute(sa.text(
        "UPDATE person_hours_account_entries "
        "SET source_type = entry_type "
        "WHERE source_type IS NULL"
    ))

    check_constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints(LEDGER_TABLE)
        if constraint.get("name")
    }
    missing_checks = [
        (
            "ck_person_hours_account_entries_ledger_system",
            "ledger_system IN ('legacy', 'daily')",
        ),
        (
            "ck_person_hours_account_entries_daily_effective_date",
            "ledger_system <> 'daily' OR "
            "(effective_date IS NOT NULL AND effective_date >= '2026-08-01')",
        ),
    ]
    missing_checks = [item for item in missing_checks if item[0] not in check_constraints]
    if missing_checks:
        if connection.dialect.name == "sqlite":
            with op.batch_alter_table(LEDGER_TABLE) as batch_op:
                for constraint_name, condition in missing_checks:
                    batch_op.create_check_constraint(constraint_name, condition)
        else:
            for constraint_name, condition in missing_checks:
                op.create_check_constraint(
                    constraint_name,
                    LEDGER_TABLE,
                    condition,
                )

    indexes = {index["name"] for index in sa.inspect(connection).get_indexes(LEDGER_TABLE)}
    _create_index_if_missing(
        indexes,
        "ix_person_hours_account_entries_ledger_system",
        ["ledger_system"],
    )
    _create_index_if_missing(
        indexes,
        "ix_person_hours_account_entries_effective_date",
        ["effective_date"],
    )
    _create_index_if_missing(
        indexes,
        "ix_person_hours_account_entries_is_active",
        ["is_active"],
    )
    _create_index_if_missing(
        indexes,
        "ix_person_hours_account_entries_person_effective",
        ["person_id", "effective_date"],
    )
    _create_index_if_missing(
        indexes,
        "ix_person_hours_account_entries_source",
        ["source_type", "source_reference_id"],
    )
    _create_index_if_missing(
        indexes,
        "uq_person_hours_account_entries_idempotency_key",
        ["idempotency_key"],
        unique=True,
    )
    if "uq_person_hours_account_entries_active_daily" not in indexes:
        op.create_index(
            "uq_person_hours_account_entries_active_daily",
            LEDGER_TABLE,
            ["person_id", "effective_date"],
            unique=True,
            postgresql_where=sa.text(
                "ledger_system = 'daily' AND entry_type = 'daily_balance' "
                "AND is_active = true"
            ),
            sqlite_where=sa.text(
                "ledger_system = 'daily' AND entry_type = 'daily_balance' "
                "AND is_active = 1"
            ),
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())

    if LEDGER_TABLE in tables:
        indexes = {index["name"] for index in inspector.get_indexes(LEDGER_TABLE)}
        for index_name in (
            "uq_person_hours_account_entries_active_daily",
            "uq_person_hours_account_entries_idempotency_key",
            "ix_person_hours_account_entries_source",
            "ix_person_hours_account_entries_person_effective",
            "ix_person_hours_account_entries_is_active",
            "ix_person_hours_account_entries_effective_date",
            "ix_person_hours_account_entries_ledger_system",
        ):
            if index_name in indexes:
                op.drop_index(index_name, table_name=LEDGER_TABLE)
        checks = {
            constraint["name"]
            for constraint in sa.inspect(connection).get_check_constraints(LEDGER_TABLE)
            if constraint.get("name")
        }
        ledger_checks = (
            "ck_person_hours_account_entries_daily_effective_date",
            "ck_person_hours_account_entries_ledger_system",
        )
        present_checks = [name for name in ledger_checks if name in checks]
        if present_checks:
            if connection.dialect.name == "sqlite":
                with op.batch_alter_table(LEDGER_TABLE) as batch_op:
                    for constraint_name in present_checks:
                        batch_op.drop_constraint(constraint_name, type_="check")
            else:
                for constraint_name in present_checks:
                    op.drop_constraint(
                        constraint_name,
                        LEDGER_TABLE,
                        type_="check",
                    )
        columns = {
            column["name"] for column in sa.inspect(connection).get_columns(LEDGER_TABLE)
        }
        for column_name in reversed(LEDGER_COLUMNS):
            if column_name in columns:
                op.drop_column(LEDGER_TABLE, column_name)

    if OPENING_TABLE in tables:
        op.drop_table(OPENING_TABLE)
    if SCHEDULE_TABLE in tables:
        op.drop_table(SCHEDULE_TABLE)


def _create_index_if_missing(
    existing_indexes: set[str],
    name: str,
    columns: list[str],
    *,
    unique: bool = False,
) -> None:
    if name not in existing_indexes:
        op.create_index(name, LEDGER_TABLE, columns, unique=unique)
        existing_indexes.add(name)
