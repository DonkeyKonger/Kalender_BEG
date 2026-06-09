from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.enums import AbsenceStatus
from app.models.person import Person


class AbsenceRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, absence_id: int) -> Absence | None:
        return self.db.get(Absence, absence_id)

    def list(
        self,
        *,
        start: date | None = None,
        end: date | None = None,
        person_id: int | None = None,
    ) -> list[Absence]:
        statement = (
            select(Absence)
            .join(Absence.person)
            .options(selectinload(Absence.person))
            .where(
                Absence.status == AbsenceStatus.ACTIVE,
                Person.deleted_at.is_(None),
                Person.is_active.is_(True),
            )
            .order_by(Absence.start_date, Absence.id)
        )
        if start is not None and end is not None:
            statement = statement.where(Absence.start_date <= end, Absence.end_date >= start)
        if person_id is not None:
            statement = statement.where(Absence.person_id == person_id)
        return list(self.db.scalars(statement))

    def add(self, absence: Absence) -> Absence:
        self.db.add(absence)
        self.db.flush()
        return absence

    def delete(self, absence: Absence) -> None:
        self.db.delete(absence)
