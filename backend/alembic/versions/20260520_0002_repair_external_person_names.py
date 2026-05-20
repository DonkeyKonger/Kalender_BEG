"""Repair external person names.

Revision ID: 20260520_0002
Revises: 20260513_0001
Create Date: 2026-05-20
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260520_0002"
down_revision: str | None = "20260513_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        r"""
        UPDATE persons
        SET
            first_name = COALESCE(NULLIF(btrim(first_name), ''), NULLIF(btrim(display_name), ''), 'Extern'),
            last_name = COALESCE(
                NULLIF(regexp_replace(btrim(display_name), '^.*\s+', ''), ''),
                NULLIF(btrim(first_name), ''),
                'Extern'
            ),
            short_code = concat(
                left(COALESCE(NULLIF(btrim(first_name), ''), NULLIF(btrim(display_name), ''), 'E'), 1),
                '.',
                COALESCE(
                    NULLIF(regexp_replace(btrim(display_name), '^.*\s+', ''), ''),
                    NULLIF(btrim(first_name), ''),
                    'Extern'
                )
            )
        WHERE person_type IN ('external', 'external_temp')
          AND (btrim(first_name) = '' OR btrim(last_name) = '' OR btrim(short_code) = '')
        """
    )


def downgrade() -> None:
    pass
