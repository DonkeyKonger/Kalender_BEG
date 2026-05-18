from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.assignment import AssignmentCreate, AssignmentUpdate
from app.services.audit_service import AuditService
from app.services.conflict_service import ConflictCheckResult, ConflictMessage, ConflictService


@dataclass(frozen=True)
class AssignmentMutationResult:
    assignment: Assignment
    warnings: list[ConflictMessage]
    infos: list[ConflictMessage]


class AssignmentService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.assignments = AssignmentRepository(db)
        self.people = PersonRepository(db)
        self.sites = SiteRepository(db)
        self.audit = AuditService(db)
        self.conflicts = ConflictService(db)

    def list_assignments(self, **filters) -> list[Assignment]:
        return self.assignments.list(**filters)

    def create_assignment(
        self,
        payload: AssignmentCreate,
        user_id: int,
    ) -> AssignmentMutationResult:
        conflict_result = self.conflicts.check_assignment(
            person_id=payload.person_id,
            site_id=payload.site_id,
            start_date=payload.start_date,
            end_date=payload.end_date,
        )
        self._reject_if_blocked(
            conflict_result,
            user_id=user_id,
            action="assignment.rejected.create",
            old_value=None,
            new_value=payload.model_dump(mode="json"),
        )

        assignment = Assignment(
            **payload.model_dump(),
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        self.assignments.add(assignment)
        self.audit.record(
            user_id=user_id,
            action="assignment.created",
            entity_type="assignment",
            entity_id=assignment.id,
            old_value=None,
            new_value=payload.model_dump(mode="json"),
        )
        self.db.commit()
        self.db.refresh(assignment)
        return AssignmentMutationResult(
            assignment=assignment,
            warnings=conflict_result.warnings,
            infos=conflict_result.infos,
        )

    def update_assignment(
        self,
        assignment_id: int,
        payload: AssignmentUpdate,
        user_id: int,
    ) -> AssignmentMutationResult:
        assignment = self.assignments.get(assignment_id)
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")

        old_value = self._assignment_snapshot(assignment)
        values = payload.model_dump(exclude_unset=True)
        person_id = values.get("person_id", assignment.person_id)
        site_id = values.get("site_id", assignment.site_id)
        start_date = values.get("start_date", assignment.start_date)
        end_date = values.get("end_date", assignment.end_date)

        conflict_result = self.conflicts.check_assignment(
            person_id=person_id,
            site_id=site_id,
            start_date=start_date,
            end_date=end_date,
            exclude_assignment_id=assignment_id,
        )
        self._reject_if_blocked(
            conflict_result,
            user_id=user_id,
            action="assignment.rejected.update",
            old_value=old_value,
            new_value=payload.model_dump(exclude_unset=True, mode="json"),
        )

        for field, value in values.items():
            setattr(assignment, field, value)
        assignment.updated_by_user_id = user_id
        self.audit.record(
            user_id=user_id,
            action="assignment.updated",
            entity_type="assignment",
            entity_id=assignment.id,
            old_value=old_value,
            new_value=self._assignment_snapshot(assignment),
        )
        self.db.commit()
        self.db.refresh(assignment)
        return AssignmentMutationResult(
            assignment=assignment,
            warnings=conflict_result.warnings,
            infos=conflict_result.infos,
        )

    def delete_assignment(self, assignment_id: int, user_id: int) -> None:
        assignment = self.assignments.get(assignment_id)
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        old_value = self._assignment_snapshot(assignment)
        self.assignments.delete(assignment)
        self.audit.record(
            user_id=user_id,
            action="assignment.deleted",
            entity_type="assignment",
            entity_id=assignment_id,
            old_value=old_value,
            new_value=None,
        )
        self.db.commit()

    def _reject_if_blocked(
        self,
        conflict_result: ConflictCheckResult,
        *,
        user_id: int,
        action: str,
        old_value: dict | None,
        new_value: dict | None,
    ) -> None:
        if not conflict_result.has_blockers:
            return

        self.audit.record(
            user_id=user_id,
            action=action,
            entity_type="assignment",
            entity_id=None,
            old_value=old_value,
            new_value={
                "requested": new_value,
                "blockers": [item.to_dict() for item in conflict_result.blockers],
                "warnings": [item.to_dict() for item in conflict_result.warnings],
                "infos": [item.to_dict() for item in conflict_result.infos],
            },
        )
        self.db.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "Einsatz konnte wegen Konflikten nicht gespeichert werden.",
                "blockers": [item.to_dict() for item in conflict_result.blockers],
                "warnings": [item.to_dict() for item in conflict_result.warnings],
                "infos": [item.to_dict() for item in conflict_result.infos],
            },
        )

    def _assignment_snapshot(self, assignment: Assignment) -> dict:
        return {
            "id": assignment.id,
            "site_id": assignment.site_id,
            "person_id": assignment.person_id,
            "start_date": assignment.start_date.isoformat(),
            "end_date": assignment.end_date.isoformat(),
            "assignment_type": assignment.assignment_type.value,
            "note": assignment.note,
        }
