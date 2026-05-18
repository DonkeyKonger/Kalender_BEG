from __future__ import annotations

from dataclasses import dataclass
from datetime import date as Date, timedelta
from typing import Literal

from sqlalchemy.orm import Session

from app.models.enums import AbsenceStatus, AbsenceType, SiteStatus
from app.repositories.absence_repository import AbsenceRepository
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository

ConflictSeverity = Literal["info", "warning", "hard"]

HARD_ABSENCE_TYPES = {AbsenceType.VACATION, AbsenceType.SICK}
WARNING_ABSENCE_TYPES = {AbsenceType.SCHOOL, AbsenceType.FREE, AbsenceType.OTHER}
BLOCKED_SITE_STATUSES = {SiteStatus.CLOSED, SiteStatus.ARCHIVED}


@dataclass(frozen=True)
class ConflictMessage:
    severity: ConflictSeverity
    code: str
    message: str
    date: Date | None = None

    def to_dict(self) -> dict:
        return {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "date": self.date.isoformat() if self.date else None,
        }


@dataclass(frozen=True)
class ConflictCheckResult:
    blockers: list[ConflictMessage]
    warnings: list[ConflictMessage]
    infos: list[ConflictMessage]

    @property
    def has_blockers(self) -> bool:
        return bool(self.blockers)


class ConflictService:
    def __init__(self, db: Session) -> None:
        self.people = PersonRepository(db)
        self.sites = SiteRepository(db)
        self.assignments = AssignmentRepository(db)
        self.absences = AbsenceRepository(db)

    def check_assignment(
        self,
        *,
        person_id: int,
        site_id: int,
        start_date: Date,
        end_date: Date,
        exclude_assignment_id: int | None = None,
        exclude_assignment_ids: set[int] | None = None,
    ) -> ConflictCheckResult:
        blockers: list[ConflictMessage] = []
        warnings: list[ConflictMessage] = []
        infos: list[ConflictMessage] = []

        person = self.people.get(person_id)
        site = self.sites.get(site_id)

        if person is None:
            blockers.append(
                ConflictMessage("hard", "person_not_found", "Person nicht gefunden.")
            )
        elif not person.is_active:
            blockers.append(
                ConflictMessage(
                    "hard",
                    "person_inactive",
                    "Deaktivierte Personen duerfen nicht eingeplant werden.",
                )
            )

        if site is None:
            blockers.append(ConflictMessage("hard", "site_not_found", "Baustelle nicht gefunden."))
        elif site.status in BLOCKED_SITE_STATUSES:
            blockers.append(
                ConflictMessage(
                    "hard",
                    "site_closed_or_archived",
                    "Geschlossene oder archivierte Baustellen duerfen nicht beplant werden.",
                )
            )

        if end_date < start_date:
            blockers.append(
                ConflictMessage("hard", "invalid_date_range", "Enddatum liegt vor Startdatum.")
            )
            return ConflictCheckResult(blockers=blockers, warnings=warnings, infos=infos)

        if person is None or site is None:
            return ConflictCheckResult(blockers=blockers, warnings=warnings, infos=infos)

        excluded_ids = set(exclude_assignment_ids or set())
        if exclude_assignment_id is not None:
            excluded_ids.add(exclude_assignment_id)
        existing_assignments = [
            assignment
            for assignment in self.assignments.list(
                start=start_date,
                end=end_date,
                person_id=person_id,
            )
            if assignment.id not in excluded_ids
        ]
        for day in self._date_range(start_date, end_date):
            assignment_count = sum(
                1
                for assignment in existing_assignments
                if assignment.start_date <= day <= assignment.end_date
            )
            total_count = assignment_count + 1
            if total_count > 2:
                blockers.append(
                    ConflictMessage(
                        "hard",
                        "too_many_assignments",
                        "Ein Mitarbeiter darf maximal zwei Einsaetze pro Tag haben.",
                        day,
                    )
                )
            elif total_count == 2:
                infos.append(
                    ConflictMessage(
                        "info",
                        "second_assignment_same_day",
                        "Der Mitarbeiter hat an diesem Tag zwei Einsaetze.",
                        day,
                    )
                )

        absences = [
            absence
            for absence in self.absences.list(start=start_date, end=end_date, person_id=person_id)
            if absence.status == AbsenceStatus.ACTIVE
        ]
        for absence in absences:
            overlap_start = max(start_date, absence.start_date)
            overlap_end = min(end_date, absence.end_date)
            if absence.absence_type in HARD_ABSENCE_TYPES:
                for day in self._date_range(overlap_start, overlap_end):
                    blockers.append(
                        ConflictMessage(
                            "hard",
                            f"absence_{absence.absence_type.value}",
                            "Urlaub und Krankheit blockieren eine Einplanung.",
                            day,
                        )
                    )
            elif absence.absence_type in WARNING_ABSENCE_TYPES:
                for day in self._date_range(overlap_start, overlap_end):
                    warnings.append(
                        ConflictMessage(
                            "warning",
                            f"absence_{absence.absence_type.value}",
                            "Abwesenheit erzeugt eine Warnung, kann aber gespeichert werden.",
                            day,
                        )
                    )

        return ConflictCheckResult(blockers=blockers, warnings=warnings, infos=infos)

    def _date_range(self, start: Date, end: Date) -> list[Date]:
        return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
