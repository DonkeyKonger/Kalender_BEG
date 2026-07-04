"""Merge customer emails into contacts.

Revision ID: 20260704_0056
Revises: 20260704_0055
Create Date: 2026-07-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260704_0056"
down_revision: str | None = "20260704_0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


customer_contacts = sa.table(
    "customer_contacts",
    sa.column("id", sa.Integer),
    sa.column("customer_id", sa.Integer),
    sa.column("contact_type", sa.String),
    sa.column("name", sa.String),
    sa.column("phone", sa.String),
    sa.column("email", sa.String),
)

customer_email_labels = sa.table(
    "customer_email_labels",
    sa.column("customer_id", sa.Integer),
    sa.column("email", sa.String),
    sa.column("email_normalized", sa.String),
    sa.column("label", sa.String),
)


def upgrade() -> None:
    op.alter_column(
        "customer_contacts",
        "contact_type",
        existing_type=sa.String(length=40),
        nullable=True,
    )
    op.alter_column(
        "customer_contacts",
        "name",
        existing_type=sa.String(length=200),
        nullable=True,
    )

    connection = op.get_bind()
    labels = connection.execute(
        sa.select(
            customer_email_labels.c.customer_id,
            customer_email_labels.c.email,
            customer_email_labels.c.email_normalized,
            customer_email_labels.c.label,
        )
    ).mappings()
    for label in labels:
        email = (label["email"] or "").strip()
        normalized_email = (label["email_normalized"] or email).strip().casefold()
        if not email or "@" not in normalized_email:
            continue
        existing_contact = connection.execute(
            sa.select(customer_contacts.c.id, customer_contacts.c.name)
            .where(customer_contacts.c.customer_id == label["customer_id"])
            .where(sa.func.lower(sa.func.trim(customer_contacts.c.email)) == normalized_email)
            .limit(1)
        ).mappings().first()
        if existing_contact:
            if label["label"] and not existing_contact["name"]:
                connection.execute(
                    customer_contacts.update()
                    .where(customer_contacts.c.id == existing_contact["id"])
                    .values(name=label["label"])
                )
            continue
        connection.execute(
            customer_contacts.insert().values(
                customer_id=label["customer_id"],
                contact_type=None,
                name=label["label"] or None,
                phone=None,
                email=email,
            )
        )

    op.drop_index("ix_customer_email_labels_customer_id", table_name="customer_email_labels")
    op.drop_table("customer_email_labels")


def downgrade() -> None:
    op.create_table(
        "customer_email_labels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("email_normalized", sa.String(length=255), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("customer_id", "email_normalized", name="uq_customer_email_labels_customer_email"),
    )
    op.create_index("ix_customer_email_labels_customer_id", "customer_email_labels", ["customer_id"])

    connection = op.get_bind()
    seen_email_labels: set[tuple[int, str]] = set()
    contacts = connection.execute(
        sa.select(
            customer_contacts.c.customer_id,
            customer_contacts.c.email,
            customer_contacts.c.name,
        ).where(customer_contacts.c.email.is_not(None))
    ).mappings()
    for contact in contacts:
        email = (contact["email"] or "").strip()
        if not email:
            continue
        email_key = (contact["customer_id"], email.casefold())
        if email_key in seen_email_labels:
            continue
        seen_email_labels.add(email_key)
        connection.execute(
            customer_email_labels.insert().values(
                customer_id=contact["customer_id"],
                email=email,
                email_normalized=email.casefold(),
                label=contact["name"],
            )
        )

    connection.execute(
        customer_contacts.update()
        .where(customer_contacts.c.name.is_(None))
        .values(name="Kontakt")
    )
    connection.execute(
        customer_contacts.update()
        .where(customer_contacts.c.contact_type.is_(None))
        .values(contact_type="monteur")
    )
    op.alter_column(
        "customer_contacts",
        "name",
        existing_type=sa.String(length=200),
        nullable=False,
    )
    op.alter_column(
        "customer_contacts",
        "contact_type",
        existing_type=sa.String(length=40),
        nullable=False,
    )
