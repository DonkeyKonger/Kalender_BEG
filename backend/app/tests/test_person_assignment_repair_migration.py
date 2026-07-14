from datetime import date
import importlib.util
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import AssignmentType, PersonEmploymentStatus, PersonType, SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User


MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260714_0075_relink_duplicate_assignment_people.py"
)
MIGRATION_SPEC = importlib.util.spec_from_file_location("person_assignment_repair_0075", MIGRATION_PATH)
assert MIGRATION_SPEC is not None and MIGRATION_SPEC.loader is not None
MIGRATION_MODULE = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION_MODULE)


def test_migration_relinks_duplicate_matrix_people_to_user_linked_person():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        canonical = Person(
            first_name="Christopher",
            last_name="Erichsen",
            display_name="Christopher Erichsen",
            short_code="CE",
            person_type=PersonType.INTERNAL,
            is_active=True,
        )
        duplicate_internal = Person(
            first_name="Christopher",
            last_name="Erichsen",
            display_name="Christopher Erichsen",
            short_code="C.Erichsen",
            person_type=PersonType.INTERNAL,
            is_active=True,
        )
        duplicate_quick_entry = Person(
            first_name="C.Erichsen",
            last_name="C.Erichsen",
            display_name="C.Erichsen",
            short_code="C.C.Erichsen",
            person_type=PersonType.EXTERNAL_TEMP,
            is_active=True,
        )
        user = User(
            username="christopher",
            display_name="Christopher Erichsen",
            password_hash="x",
            role=UserRole.MONTEUR,
            is_active=True,
            person=canonical,
        )
        sites = [
            Site(site_number="8007", name="Schüchtermann Klinik", status=SiteStatus.ACTIVE),
            Site(site_number="8027", name="KW 27 intern", status=SiteStatus.ACTIVE),
            Site(site_number="8028", name="KW 27 Schnelleingabe", status=SiteStatus.COMPLETED),
        ]
        db.add_all([canonical, duplicate_internal, duplicate_quick_entry, user, *sites])
        db.flush()
        db.add_all([
            Assignment(
                site_id=sites[0].id,
                person_id=canonical.id,
                start_date=date(2026, 5, 12),
                end_date=date(2026, 5, 12),
                assignment_type=AssignmentType.SELF_PLANNED,
            ),
            Assignment(
                site_id=sites[1].id,
                person_id=duplicate_internal.id,
                start_date=date(2026, 6, 29),
                end_date=date(2026, 7, 3),
                assignment_type=AssignmentType.REGULAR,
            ),
            Assignment(
                site_id=sites[2].id,
                person_id=duplicate_quick_entry.id,
                start_date=date(2026, 7, 6),
                end_date=date(2026, 7, 10),
                assignment_type=AssignmentType.REGULAR,
            ),
        ])
        db.commit()
        canonical_id = canonical.id
        duplicate_ids = {duplicate_internal.id, duplicate_quick_entry.id}

    with engine.begin() as connection:
        repaired = MIGRATION_MODULE.relink_duplicate_assignment_people(connection)

    with Session(engine) as db:
        assignments = list(db.scalars(select(Assignment).order_by(Assignment.start_date)))
        repaired_people = list(db.scalars(select(Person).where(Person.id.in_(duplicate_ids))))

    assert {(source_id, target_id) for source_id, target_id, _ in repaired} == {
        (duplicate_id, canonical_id) for duplicate_id in duplicate_ids
    }
    assert {assignment.person_id for assignment in assignments} == {canonical_id}
    assert all(person.is_active is False for person in repaired_people)
    assert all(
        person.employment_status == PersonEmploymentStatus.DEPARTED.value
        for person in repaired_people
    )
