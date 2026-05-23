from dataclasses import dataclass
from datetime import timedelta

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.assignment import AssignmentCreate, AssignmentSegmentMove, AssignmentUpdate
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

    def move_assignment_segment(
        self,
        assignment_id: int,
        payload: AssignmentSegmentMove,
        user_id: int,
    ) -> AssignmentMutationResult:
        assignment = self.assignments.get(assignment_id)
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")

        if (
            payload.segment_start_date < assignment.start_date
            or payload.segment_end_date > assignment.end_date
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Segment liegt ausserhalb des Einsatzes.")

        duration_days = (payload.segment_end_date - payload.segment_start_date).days
        target_end_date = payload.target_start_date + timedelta(days=duration_days)
        if (
            payload.target_site_id == assignment.site_id
            and payload.target_start_date == payload.segment_start_date
            and target_end_date == payload.segment_end_date
        ):
            return AssignmentMutationResult(assignment=assignment, warnings=[], infos=[])

        old_value = self._assignment_snapshot(assignment)
        conflict_result = self.conflicts.check_assignment(
            person_id=assignment.person_id,
            site_id=payload.target_site_id,
            start_date=payload.target_start_date,
            end_date=target_end_date,
            exclude_assignment_id=assignment_id,
        )
        self._reject_if_blocked(
            conflict_result,
            user_id=user_id,
            action="assignment.rejected.segment_move",
            old_value=old_value,
            new_value=payload.model_dump(mode="json"),
        )

        original_start_date = assignment.start_date
        original_end_date = assignment.end_date

        if (
            payload.segment_start_date == original_start_date
            and payload.segment_end_date == original_end_date
        ):
            assignment.site_id = payload.target_site_id
            assignment.start_date = payload.target_start_date
            assignment.end_date = target_end_date
            assignment.updated_by_user_id = user_id
            moved_assignment = assignment
            right_remainder = None
        else:
            moved_assignment = Assignment(
                site_id=payload.target_site_id,
                person_id=assignment.person_id,
                start_date=payload.target_start_date,
                end_date=target_end_date,
                assignment_type=assignment.assignment_type,
                note=assignment.note,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
            )
            right_remainder = None

            if payload.segment_start_date == original_start_date:
                assignment.start_date = payload.segment_end_date + timedelta(days=1)
            elif payload.segment_end_date == original_end_date:
                assignment.end_date = payload.segment_start_date - timedelta(days=1)
            else:
                right_remainder = Assignment(
                    site_id=assignment.site_id,
                    person_id=assignment.person_id,
                    start_date=payload.segment_end_date + timedelta(days=1),
                    end_date=original_end_date,
                    assignment_type=assignment.assignment_type,
                    note=assignment.note,
                    created_by_user_id=assignment.created_by_user_id,
                    updated_by_user_id=user_id,
                )
                assignment.end_date = payload.segment_start_date - timedelta(days=1)
                self.assignments.add(right_remainder)

            assignment.updated_by_user_id = user_id
            self.assignments.add(moved_assignment)

        new_value = {
            "source": self._assignment_snapshot(assignment),
            "moved": self._assignment_snapshot(moved_assignment),
        }
        if right_remainder is not None:
            new_value["right_remainder"] = self._assignment_snapshot(right_remainder)
        self.audit.record(
            user_id=user_id,
            action="assignment.segment_moved",
            entity_type="assignment",
            entity_id=assignment_id,
            old_value=old_value,
            new_value=new_value,
        )
        self.db.commit()
        self.db.refresh(moved_assignment)
        return AssignmentMutationResult(
            assignment=moved_assignment,
            warnings=conflict_result.warnings,
            infos=conflict_result.infos,
        )

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
