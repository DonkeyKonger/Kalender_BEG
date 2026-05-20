from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.absence import Absence
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


def clean_absence_values(values: dict) -> dict:
    cleaned = dict(values)
    if isinstance(cleaned.get("note"), str):
        cleaned["note"] = cleaned["note"].strip() or None
    return cleaned


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
