"""Initial relational schema.

Revision ID: 20260513_0001
Revises:
Create Date: 2026-05-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260513_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

user_role = postgresql.ENUM(
    "admin",
    "project_manager",
    "office",
    "monteur",
    name="user_role",
)
person_type = postgresql.ENUM(
    "internal",
    "external",
    "external_temp",
    name="person_type",
)
site_status = postgresql.ENUM(
    "active",
    "paused",
    "closed",
    "archived",
    name="site_status",
)
assignment_type = postgresql.ENUM(
    "regular",
    "support",
    "emergency",
    name="assignment_type",
)
absence_type = postgresql.ENUM(
    "vacation",
    "sick",
    "school",
    "free",
    "other",
    name="absence_type",
)
absence_status = postgresql.ENUM(
    "active",
    "cancelled",
    name="absence_status",
)
vehicle_type = postgresql.ENUM(
    "car",
    "van",
    "truck",
    "other",
    name="vehicle_type",
)


def upgrade() -> None:
    bind = op.get_bind()
    for enum_type in (
        user_role,
        person_type,
        site_status,
        assignment_type,
        absence_type,
        absence_status,
        vehicle_type,
    ):
        enum_type.create(bind, checkfirst=True)

    op.create_table(
        "persons",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("first_name", sa.String(length=100), nullable=False),
        sa.Column("last_name", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("short_code", sa.String(length=30), nullable=False),
        sa.Column("person_type", person_type, nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=80), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_persons_short_code", "persons", ["short_code"])

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=80), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", user_role, nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    op.create_table(
        "sites",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_number", sa.String(length=80), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column("customer", sa.String(length=200), nullable=True),
        sa.Column("project_manager_person_id", sa.Integer(), nullable=True),
        sa.Column("status", site_status, nullable=False),
        sa.Column("info", sa.Text(), nullable=True),
        sa.Column("color", sa.String(length=30), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["closed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_manager_person_id"], ["persons.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sites_name", "sites", ["name"])
    op.create_index("ix_sites_site_number", "sites", ["site_number"], unique=True)
    op.create_index("ix_sites_status", "sites", ["status"])

    op.create_table(
        "vehicles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("license_plate", sa.String(length=30), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("vehicle_type", vehicle_type, nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("gps_vehicle_id", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_vehicles_license_plate", "vehicles", ["license_plate"], unique=True)

    op.create_table(
        "assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("assignment_type", assignment_type, nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_assignments_person_date_range",
        "assignments",
        ["person_id", "start_date", "end_date"],
    )
    op.create_index(
        "ix_assignments_site_date_range",
        "assignments",
        ["site_id", "start_date", "end_date"],
    )

    op.create_table(
        "absences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("absence_type", absence_type, nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("status", absence_status, nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_absences_person_date_range", "absences", ["person_id", "start_date", "end_date"])

    op.create_table(
        "site_vehicle_assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("vehicle_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["vehicle_id"], ["vehicles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_vehicle_assignments_date_range",
        "site_vehicle_assignments",
        ["vehicle_id", "start_date", "end_date"],
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("entity_type", sa.String(length=100), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=True),
        sa.Column("old_value_json", sa.JSON(), nullable=True),
        sa.Column("new_value_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_entity_id", "audit_logs", ["entity_id"])
    op.create_index("ix_audit_logs_entity_type", "audit_logs", ["entity_type"])
    op.create_index("ix_audit_logs_user_id", "audit_logs", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_logs_user_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity_type", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index("ix_site_vehicle_assignments_date_range", table_name="site_vehicle_assignments")
    op.drop_table("site_vehicle_assignments")
    op.drop_index("ix_absences_person_date_range", table_name="absences")
    op.drop_table("absences")
    op.drop_index("ix_assignments_site_date_range", table_name="assignments")
    op.drop_index("ix_assignments_person_date_range", table_name="assignments")
    op.drop_table("assignments")
    op.drop_index("ix_vehicles_license_plate", table_name="vehicles")
    op.drop_table("vehicles")
    op.drop_index("ix_sites_status", table_name="sites")
    op.drop_index("ix_sites_site_number", table_name="sites")
    op.drop_index("ix_sites_name", table_name="sites")
    op.drop_table("sites")
    op.drop_index("ix_users_username", table_name="users")
    op.drop_table("users")
    op.drop_index("ix_persons_short_code", table_name="persons")
    op.drop_table("persons")

    bind = op.get_bind()
    for enum_type in (
        vehicle_type,
        absence_status,
        absence_type,
        assignment_type,
        site_status,
        person_type,
        user_role,
    ):
        enum_type.drop(bind, checkfirst=True)
