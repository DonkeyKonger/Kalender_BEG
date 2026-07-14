"""Relink duplicate assignment people to their user-linked person.

Revision ID: 20260714_0075
Revises: 20260713_0074
Create Date: 2026-07-14
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260714_0075"
down_revision: str | None = "20260713_0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REPAIR_NOTE = "Automatisch der verknüpften Mitarbeiter-ID zugeordnet."


def upgrade() -> None:
    relink_duplicate_assignment_people(op.get_bind())


def downgrade() -> None:
    # The previous person_id cannot be reconstructed reliably after assignments
    # have been linked to the canonical, user-owned person record.
    pass


def relink_duplicate_assignment_people(
    connection: sa.Connection,
) -> list[tuple[int, int, int]]:
    inspector = sa.inspect(connection)
    required_tables = {
        "absences",
        "assignments",
        "dashboard_notes",
        "gps_points",
        "person_hours_account_entries",
        "person_vacation_carryovers",
        "persons",
        "sites",
        "time_entry_weekly_reviews",
        "tool_material_items",
        "users",
        "work_time_entries",
    }
    if not required_tables.issubset(inspector.get_table_names()):
        return []

    metadata = sa.MetaData()
    tables = {
        name: sa.Table(name, metadata, autoload_with=connection)
        for name in required_tables
    }
    persons = tables["persons"]
    users = tables["users"]
    assignments = tables["assignments"]

    canonical_people = (
        sa.select(
            persons.c.id,
            persons.c.first_name,
            persons.c.last_name,
            persons.c.display_name,
            persons.c.short_code,
        )
        .select_from(persons.join(users, users.c.person_id == persons.c.id))
        .where(
            users.c.is_active.is_(True),
            persons.c.deleted_at.is_(None),
            persons.c.is_active.is_(True),
            persons.c.person_type == "internal",
        )
        .distinct()
        .subquery("canonical_people")
    )
    duplicate = persons.alias("duplicate_person")

    identity_matches = sa.or_(
        _normalized(duplicate.c.display_name) == _normalized(canonical_people.c.display_name),
        sa.and_(
            _normalized(duplicate.c.first_name) == _normalized(canonical_people.c.first_name),
            _normalized(duplicate.c.last_name) == _normalized(canonical_people.c.last_name),
        ),
        _normalized(duplicate.c.display_name) == _normalized(canonical_people.c.short_code),
        _normalized(duplicate.c.short_code) == _normalized(canonical_people.c.short_code),
        _normalized(duplicate.c.display_name) == _calendar_identity(canonical_people),
        _normalized(duplicate.c.short_code) == _calendar_identity(canonical_people),
    )
    non_assignment_dependencies = [
        (tables["users"], "person_id"),
        (tables["absences"], "person_id"),
        (tables["dashboard_notes"], "employee_id"),
        (tables["gps_points"], "person_id"),
        (tables["person_hours_account_entries"], "person_id"),
        (tables["person_vacation_carryovers"], "person_id"),
        (tables["sites"], "project_manager_person_id"),
        (tables["time_entry_weekly_reviews"], "person_id"),
        (tables["tool_material_items"], "employee_id"),
        (tables["work_time_entries"], "person_id"),
    ]
    has_no_other_dependencies = [
        ~sa.exists(sa.select(sa.literal(1)).where(table.c[column] == duplicate.c.id))
        for table, column in non_assignment_dependencies
    ]
    candidate_statement = (
        sa.select(
            duplicate.c.id.label("duplicate_id"),
            sa.func.min(canonical_people.c.id).label("canonical_id"),
        )
        .select_from(duplicate.join(canonical_people, identity_matches))
        .where(
            duplicate.c.id != canonical_people.c.id,
            duplicate.c.deleted_at.is_(None),
            duplicate.c.person_type.in_(["internal", "external_temp"]),
            sa.exists(
                sa.select(sa.literal(1)).where(assignments.c.person_id == duplicate.c.id)
            ),
            *has_no_other_dependencies,
        )
        .group_by(duplicate.c.id)
        .having(sa.func.count(sa.distinct(canonical_people.c.id)) == 1)
    )
    candidates = connection.execute(candidate_statement).mappings().all()
    repaired: list[tuple[int, int, int]] = []

    for candidate in candidates:
        duplicate_id = int(candidate["duplicate_id"])
        canonical_id = int(candidate["canonical_id"])
        assignment_count = int(
            connection.scalar(
                sa.select(sa.func.count(assignments.c.id)).where(
                    assignments.c.person_id == duplicate_id
                )
            )
            or 0
        )
        if assignment_count == 0:
            continue

        assignment_values: dict[str, object] = {"person_id": canonical_id}
        if "updated_at" in assignments.c:
            assignment_values["updated_at"] = sa.func.now()
        connection.execute(
            assignments.update()
            .where(assignments.c.person_id == duplicate_id)
            .values(**assignment_values)
        )

        person_values: dict[str, object] = {
            "is_active": False,
            "employment_status": "departed",
            "notes": sa.case(
                (persons.c.notes.is_(None), REPAIR_NOTE),
                else_=persons.c.notes + "\n" + REPAIR_NOTE,
            ),
        }
        if "updated_at" in persons.c:
            person_values["updated_at"] = sa.func.now()
        connection.execute(
            persons.update()
            .where(persons.c.id == duplicate_id)
            .values(**person_values)
        )
        repaired.append((duplicate_id, canonical_id, assignment_count))

    return repaired


def _normalized(column: sa.ColumnElement) -> sa.ColumnElement:
    return sa.func.lower(sa.func.trim(column))


def _calendar_identity(person_table: sa.FromClause) -> sa.ColumnElement:
    return _normalized(
        sa.func.substr(sa.func.trim(person_table.c.first_name), 1, 1)
        + sa.literal(".")
        + sa.func.trim(person_table.c.last_name)
    )
