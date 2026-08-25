"""Add immutable extra-work signed PDF snapshots and photo selection.

Revision ID: 20260825_0105
Revises: 20260825_0104
Create Date: 2026-08-25
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260825_0105"
down_revision: str | None = "20260825_0104"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TICKET_TABLE = "extra_work_tickets"
PHOTO_TABLE = "extra_work_ticket_photos"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    ticket_columns = {column["name"] for column in inspector.get_columns(TICKET_TABLE)}
    photo_columns = {column["name"] for column in inspector.get_columns(PHOTO_TABLE)}

    with op.batch_alter_table(TICKET_TABLE) as batch_op:
        if "signed_pdf_content" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_pdf_content", sa.LargeBinary(), nullable=True))
        if "signed_pdf_filename" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_pdf_filename", sa.String(length=255), nullable=True))
        if "signed_pdf_sha256" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_pdf_sha256", sa.String(length=64), nullable=True))
        if "signed_pdf_version" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_pdf_version", sa.String(length=80), nullable=True))
        if "signed_photo_manifest" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_photo_manifest", sa.JSON(), nullable=True))
        if "signed_snapshot_kind" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_snapshot_kind", sa.String(length=48), nullable=True))
        if "signed_snapshot_created_at" not in ticket_columns:
            batch_op.add_column(sa.Column("signed_snapshot_created_at", sa.DateTime(timezone=True), nullable=True))

    inspector = sa.inspect(connection)
    ticket_indexes = {index["name"] for index in inspector.get_indexes(TICKET_TABLE)}
    if "ix_extra_work_tickets_signed_snapshot_kind" not in ticket_indexes:
        op.create_index(
            "ix_extra_work_tickets_signed_snapshot_kind",
            TICKET_TABLE,
            ["signed_snapshot_kind"],
        )

    with op.batch_alter_table(PHOTO_TABLE) as batch_op:
        if "customer_document_selected" not in photo_columns:
            batch_op.add_column(
                sa.Column(
                    "customer_document_selected",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.true(),
                )
            )
        if "content_sha256" not in photo_columns:
            batch_op.add_column(sa.Column("content_sha256", sa.String(length=64), nullable=True))

    connection.execute(
        sa.text(
            "UPDATE extra_work_tickets "
            "SET signed_snapshot_kind = 'legacy_pending_freeze' "
            "WHERE customer_signed_at IS NOT NULL AND signed_snapshot_kind IS NULL"
        )
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    ticket_indexes = {index["name"] for index in inspector.get_indexes(TICKET_TABLE)}
    if "ix_extra_work_tickets_signed_snapshot_kind" in ticket_indexes:
        op.drop_index("ix_extra_work_tickets_signed_snapshot_kind", table_name=TICKET_TABLE)
    with op.batch_alter_table(PHOTO_TABLE) as batch_op:
        batch_op.drop_column("content_sha256")
        batch_op.drop_column("customer_document_selected")
    with op.batch_alter_table(TICKET_TABLE) as batch_op:
        batch_op.drop_column("signed_snapshot_created_at")
        batch_op.drop_column("signed_snapshot_kind")
        batch_op.drop_column("signed_photo_manifest")
        batch_op.drop_column("signed_pdf_version")
        batch_op.drop_column("signed_pdf_sha256")
        batch_op.drop_column("signed_pdf_filename")
        batch_op.drop_column("signed_pdf_content")
