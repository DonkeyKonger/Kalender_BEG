from datetime import date as Date, timedelta

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.models.person import Person
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.matrix import MatrixCellPatch, MatrixEntryInput, MatrixRangePatch
from app.services.audit_service import AuditService
from app.services.conflict_service import ConflictMessage, ConflictService
from app.services.external_person_service import ExternalPersonService


class MatrixMutationService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.assignments = AssignmentRepository(db)
        self.people = PersonRepository(db)
        self.sites = SiteRepository(db)
        self.audit = AuditService(db)
        self.conflicts = ConflictService(db)
        self.external_people = ExternalPersonService(db)

    def patch_cell(self, payload: MatrixCellPatch, user_id: int) -> dict:
        return self._replace_range(
            site_id=payload.site_id,
            start_date=payload.date,
            end_date=payload.date,
            entries=payload.entries,
            user_id=user_id,
            action="matrix.cell.updated",
        )

    def patch_range(self, payload: MatrixRangePatch, user_id: int) -> dict:
        if payload.end_date < payload.start_date:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
        return self._replace_range(
            site_id=payload.site_id,
            start_date=payload.start_date,
            end_date=payload.end_date,
            entries=payload.entries,
            user_id=user_id,
            action="matrix.range.updated",
        )

    def _replace_range(
        self,
        *,
        site_id: int,
        start_date: Date,
        end_date: Date,
        entries: list[MatrixEntryInput],
        user_id: int,
        action: str,
    ) -> dict:
        if self.sites.get(site_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustelle nicht gefunden.")

        people = self._resolve_entries(entries)
        existing = self.assignments.list(start=start_date, end=end_date, site_id=site_id)
        excluded_ids = {assignment.id for assignment in existing}
        blockers: list[ConflictMessage] = []
        warnings: list[ConflictMessage] = []
        infos: list[ConflictMessage] = []

        for person in people:
            check = self.conflicts.check_assignment(
                person_id=person.id,
                site_id=site_id,
                start_date=start_date,
                end_date=end_date,
                exclude_assignment_ids=excluded_ids,
            )
            blockers.extend(check.blockers)
            warnings.extend(check.warnings)
            infos.extend(check.infos)

        old_value = {"assignments": [self._snapshot(item) for item in existing]}
        requested = {
            "site_id": site_id,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "people": [person.id for person in people],
        }

        if blockers:
            self.audit.record(
                user_id=user_id,
                action=f"{action}.rejected",
                entity_type="matrix",
                entity_id=site_id,
                old_value=old_value,
                new_value={
                    "requested": requested,
                    "blockers": [item.to_dict() for item in blockers],
                    "warnings": [item.to_dict() for item in warnings],
                    "infos": [item.to_dict() for item in infos],
                },
            )
            self.db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "message": "Matrixaenderung wurde wegen Konflikten blockiert.",
                    "blockers": [item.to_dict() for item in blockers],
                    "warnings": [item.to_dict() for item in warnings],
                    "infos": [item.to_dict() for item in infos],
                },
            )

        for assignment in existing:
            self._split_or_delete_assignment(assignment, start_date, end_date, user_id)

        created = []
        for person in people:
            assignment = Assignment(
                site_id=site_id,
                person_id=person.id,
                start_date=start_date,
                end_date=end_date,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            self.assignments.add(assignment)
            created.append(assignment)

        self.audit.record(
            user_id=user_id,
            action=action,
            entity_type="matrix",
            entity_id=site_id,
            old_value=old_value,
            new_value={**requested, "created_count": len(created)},
        )
        self.db.commit()
        return {
            "warnings": [item.to_dict() for item in warnings],
            "infos": [item.to_dict() for item in infos],
        }

    def _resolve_entries(self, entries: list[MatrixEntryInput]) -> list[Person]:
        people: list[Person] = []
        seen_ids: set[int] = set()
        for entry in entries:
            person = self._resolve_entry(entry)
            if person.id not in seen_ids:
                people.append(person)
                seen_ids.add(person.id)
        return people

    def _resolve_entry(self, entry: MatrixEntryInput) -> Person:
        if entry.person_id is not None and entry.external_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eingabe ist nicht eindeutig.")
        if entry.person_id is not None:
            person = self.people.get(entry.person_id)
            if person is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")
            return person
        if entry.external_name:
            return self.external_people.resolve_external_temp(entry.external_name)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Matrixeintrag ist leer.")

    def _split_or_delete_assignment(
        self,
        assignment: Assignment,
        start_date: Date,
        end_date: Date,
        user_id: int,
    ) -> None:
        if assignment.start_date < start_date:
            self.assignments.add(
                Assignment(
                    site_id=assignment.site_id,
                    person_id=assignment.person_id,
                    start_date=assignment.start_date,
                    end_date=start_date - timedelta(days=1),
                    assignment_type=assignment.assignment_type,
                    note=assignment.note,
                    created_by_user_id=assignment.created_by_user_id,
                    updated_by_user_id=user_id,
                )
            )
        if assignment.end_date > end_date:
            self.assignments.add(
                Assignment(
                    site_id=assignment.site_id,
                    person_id=assignment.person_id,
                    start_date=end_date + timedelta(days=1),
                    end_date=assignment.end_date,
                    assignment_type=assignment.assignment_type,
                    note=assignment.note,
                    created_by_user_id=assignment.created_by_user_id,
                    updated_by_user_id=user_id,
                )
            )
        self.assignments.delete(assignment)

    def _snapshot(self, assignment: Assignment) -> dict:
        return {
            "id": assignment.id,
            "site_id": assignment.site_id,
            "person_id": assignment.person_id,
            "start_date": assignment.start_date.isoformat(),
            "end_date": assignment.end_date.isoformat(),
            "assignment_type": assignment.assignment_type.value,
            "note": assignment.note,
        }
