"""Add customer master data.

Revision ID: 20260601_0017
Revises: 20260528_0016
Create Date: 2026-06-01 10:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260601_0017"
down_revision: str | None = "20260528_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("company_name", sa.String(length=200), nullable=False),
        sa.Column("address_street", sa.String(length=200), nullable=True),
        sa.Column("address_house_number", sa.String(length=40), nullable=True),
        sa.Column("address_postal_code", sa.String(length=20), nullable=True),
        sa.Column("address_city", sa.String(length=120), nullable=True),
        sa.Column("address_country", sa.String(length=120), nullable=True),
        sa.Column("company_phone", sa.String(length=80), nullable=True),
        sa.Column("project_lead_name", sa.String(length=200), nullable=True),
        sa.Column("project_lead_phone", sa.String(length=80), nullable=True),
        sa.Column("project_lead_email", sa.String(length=255), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customers_company_name", "customers", ["company_name"])
    op.create_index("ix_customers_is_active", "customers", ["is_active"])

    op.create_table(
        "customer_contacts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("contact_type", sa.String(length=40), nullable=False, server_default="monteur"),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("phone", sa.String(length=80), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_customer_contacts_customer_id", "customer_contacts", ["customer_id"])


def downgrade() -> None:
    op.drop_index("ix_customer_contacts_customer_id", table_name="customer_contacts")
    op.drop_table("customer_contacts")
    op.drop_index("ix_customers_is_active", table_name="customers")
    op.drop_index("ix_customers_company_name", table_name="customers")
    op.drop_table("customers")
