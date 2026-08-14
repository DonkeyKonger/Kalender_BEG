from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.models.person_vacation_carryover import PersonVacationCarryover
from app.repositories.absence_repository import AbsenceRepository
from app.repositories.person_repository import PersonRepository
from app.schemas.absence import AbsenceCreate, AbsenceUpdate
from app.services.audit_service import AuditService


class AbsenceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.absences = AbsenceRepository(db)
        self.people = PersonRepository(db)
        self.audit = AuditService(db)

    def list_absences(self, **filters) -> list[Absence]:
        return self.absences.list(**filters)

    def get_person_year_summary(self, *, person: Person, year: int) -> "PersonYearAbsenceSummary":
        """Return the shared workday-based absence totals for one person and year."""
        return self.get_person_year_data(person=person, year=year).summary

    def get_person_year_data(self, *, person: Person, year: int) -> "PersonYearAbsenceData":
        """Return active vacation/sickness records and their shared yearly totals."""
        ensure_valid_carryover_year(year)
        year_start = date(year, 1, 1)
        year_end = date(year, 12, 31)
        absences = tuple(
            self.db.scalars(
                select(Absence).where(
                    Absence.person_id == person.id,
                    Absence.status == AbsenceStatus.ACTIVE,
                    Absence.absence_type.in_((AbsenceType.VACATION, AbsenceType.SICK)),
                    Absence.start_date <= year_end,
                    Absence.end_date >= year_start,
                )
            )
        )
        vacation_days = sum(
            count_absence_weekdays(absence.start_date, absence.end_date, year)
            for absence in absences
            if absence.absence_type == AbsenceType.VACATION
        )
        sick_days = sum(
            count_absence_weekdays(absence.start_date, absence.end_date, year)
            for absence in absences
            if absence.absence_type == AbsenceType.SICK
        )
        carryover = self._find_vacation_carryover(person_id=person.id, year=year)
        total_vacation_days = (person.annual_vacation_days or 0) + (
            carryover.carryover_days if carryover is not None else 0
        )
        return PersonYearAbsenceData(
            summary=PersonYearAbsenceSummary(
                total_vacation_days=total_vacation_days,
                vacation_days=vacation_days,
                remaining_vacation_days=total_vacation_days - vacation_days,
                sick_days=sick_days,
            ),
            absences=absences,
        )

    def get_vacation_carryover(
        self, *, person_id: int, year: int
    ) -> PersonVacationCarryover | None:
        self._ensure_person_exists(person_id)
        ensure_valid_carryover_year(year)
        return self._find_vacation_carryover(person_id=person_id, year=year)

    def set_vacation_carryover(
        self,
        *,
        person_id: int,
        year: int,
        carryover_days: int,
        user_id: int,
    ) -> PersonVacationCarryover:
        self._ensure_person_exists(person_id)
        ensure_valid_carryover_year(year)
        if carryover_days < 0 or carryover_days > 365:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Resturlaub muss zwischen 0 und 365 Tagen liegen."
            )
        carryover = self._find_vacation_carryover(person_id=person_id, year=year)
        old_value = vacation_carryover_snapshot(carryover) if carryover is not None else None
        if carryover is None:
            carryover = PersonVacationCarryover(
                person_id=person_id,
                year=year,
                carryover_days=carryover_days,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            self.db.add(carryover)
            self.db.flush()
        else:
            carryover.carryover_days = carryover_days
            carryover.updated_by_user_id = user_id
        self.audit.record(
            user_id=user_id,
            action="absence.vacation_carryover.updated",
            entity_type="person_vacation_carryover",
            entity_id=carryover.id,
            old_value=old_value,
            new_value=vacation_carryover_snapshot(carryover),
        )
        self.db.commit()
        self.db.refresh(carryover)
        return carryover

    def create_absence(self, payload: AbsenceCreate, user_id: int) -> Absence:
        values = clean_absence_values(payload.model_dump())
        self._ensure_person_exists(values["person_id"])
        absence = Absence(
            **values,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        self.absences.add(absence)
        self.audit.record(
            user_id=user_id,
            action="absence.created",
            entity_type="absence",
            entity_id=absence.id,
            old_value=None,
            new_value=absence_snapshot(absence),
        )
        self.db.commit()
        self.db.refresh(absence)
        return absence

    def update_absence(self, absence_id: int, payload: AbsenceUpdate, user_id: int) -> Absence:
        absence = self.absences.get(absence_id)
        if absence is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Abwesenheit nicht gefunden.")

        old_value = absence_snapshot(absence)
        values = clean_absence_values(payload.model_dump(exclude_unset=True))
        person_id = values.get("person_id", absence.person_id)
        self._ensure_person_exists(person_id)
        start_date = values.get("start_date", absence.start_date)
        end_date = values.get("end_date", absence.end_date)
        if end_date < start_date:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")

        for field, value in values.items():
            setattr(absence, field, value)
        absence.updated_by_user_id = user_id
        self.audit.record(
            user_id=user_id,
            action="absence.updated",
            entity_type="absence",
            entity_id=absence.id,
            old_value=old_value,
            new_value=absence_snapshot(absence),
        )
        self.db.commit()
        self.db.refresh(absence)
        return absence

    def delete_absence(self, absence_id: int, user_id: int) -> None:
        absence = self.absences.get(absence_id)
        if absence is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Abwesenheit nicht gefunden.")
        old_value = absence_snapshot(absence)
        self.absences.delete(absence)
        self.audit.record(
            user_id=user_id,
            action="absence.deleted",
            entity_type="absence",
            entity_id=absence_id,
            old_value=old_value,
            new_value=None,
        )
        self.db.commit()

    def _ensure_person_exists(self, person_id: int) -> None:
        if self.people.get(person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")

    def _find_vacation_carryover(
        self, *, person_id: int, year: int
    ) -> PersonVacationCarryover | None:
        return self.db.scalar(
            select(PersonVacationCarryover)
            .where(PersonVacationCarryover.person_id == person_id)
            .where(PersonVacationCarryover.year == year)
        )


def clean_absence_values(values: dict) -> dict:
    cleaned = dict(values)
    if isinstance(cleaned.get("note"), str):
        cleaned["note"] = cleaned["note"].strip() or None
    return cleaned


@dataclass(frozen=True)
class PersonYearAbsenceSummary:
    total_vacation_days: int
    vacation_days: int
    remaining_vacation_days: int
    sick_days: int


@dataclass(frozen=True)
class PersonYearAbsenceData:
    summary: PersonYearAbsenceSummary
    absences: tuple[Absence, ...]


def count_absence_weekdays(start_date: date, end_date: date, year: int) -> int:
    """Count Monday through Friday within the selected calendar year, inclusively."""
    return len(absence_weekdays(start_date, end_date, year))


def absence_weekdays(start_date: date, end_date: date, year: int) -> tuple[date, ...]:
    """Return the workdays used by the central yearly absence calculation."""
    clipped_start = max(start_date, date(year, 1, 1))
    clipped_end = min(end_date, date(year, 12, 31))
    if clipped_end < clipped_start:
        return ()
    days: list[date] = []
    cursor = clipped_start
    while cursor <= clipped_end:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    return tuple(days)


def absence_snapshot(absence: Absence) -> dict:
    return {
        "id": absence.id,
        "person_id": absence.person_id,
        "absence_type": absence.absence_type.value,
        "start_date": absence.start_date.isoformat(),
        "end_date": absence.end_date.isoformat(),
        "status": absence.status.value,
        "note": absence.note,
    }


def ensure_valid_carryover_year(year: int) -> None:
    if year < 2000 or year > 2100:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Jahr ist ungültig.")


def vacation_carryover_snapshot(carryover: PersonVacationCarryover | None) -> dict | None:
    if carryover is None:
        return None
    return {
        "id": carryover.id,
        "person_id": carryover.person_id,
        "year": carryover.year,
        "carryover_days": carryover.carryover_days,
    }
