from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment


class AssignmentRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, assignment_id: int) -> Assignment | None:
        return self.db.get(Assignment, assignment_id)

    def list(
        self,
        *,
        start: date | None = None,
        end: date | None = None,
        person_id: int | None = None,
        site_id: int | None = None,
    ) -> list[Assignment]:
        statement = (
            select(Assignment)
            .options(selectinload(Assignment.person))
            .order_by(Assignment.start_date, Assignment.id)
        )
        if start is not None and end is not None:
            statement = statement.where(Assignment.start_date <= end, Assignment.end_date >= start)
        if person_id is not None:
            statement = statement.where(Assignment.person_id == person_id)
        if site_id is not None:
            statement = statement.where(Assignment.site_id == site_id)
        return list(self.db.scalars(statement))

    def add(self, assignment: Assignment) -> Assignment:
        self.db.add(assignment)
        self.db.flush()
        return assignment

    def delete(self, assignment: Assignment) -> None:
        self.db.delete(assignment)
