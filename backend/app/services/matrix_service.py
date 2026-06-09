from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus
from app.models.person import Person
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.repositories.absence_repository import AbsenceRepository
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.site_repository import SiteRepository
from app.services.person_display import calendar_short_code
from app.schemas.matrix import (
    MatrixAbsence,
    MatrixAssignment,
    MatrixCell,
    MatrixDay,
    MatrixPerson,
    MatrixResponse,
    MatrixRow,
    MatrixSite,
)

MAX_MATRIX_DAYS = 90


class MatrixService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.sites = SiteRepository(db)
        self.assignments = AssignmentRepository(db)
        self.absences = AbsenceRepository(db)

    def get_matrix(
        self,
        *,
        start: date,
        end: date,
        include_weekends: bool = False,
        include_closed: bool = False,
    ) -> MatrixResponse:
        if end < start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
        if (end - start).days + 1 > MAX_MATRIX_DAYS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Matrixzeitraum ist zu gross.")

        all_days = self._date_range(start, end)
        assignments = self.assignments.list(start=start, end=end)
        planned_weekend_dates = {
            day
            for assignment in assignments
            for day in self._date_range(
                max(assignment.start_date, start),
                min(assignment.end_date, end),
            )
            if day.weekday() >= 5
        }
        visible_days = [
            day
            for day in all_days
            if include_weekends or day.weekday() < 5 or day in planned_weekend_dates
        ]

        visible_sites = self.sites.list(include_closed=include_closed)
        site_ids = {site.id for site in visible_sites}
        assignments = [assignment for assignment in assignments if assignment.site_id in site_ids]
        marks = self._list_marks(site_ids=site_ids, start=start, end=end)
        person_ids = {assignment.person_id for assignment in assignments}
        absences = [
            absence
            for absence in self.absences.list(start=start, end=end)
            if absence.status == AbsenceStatus.ACTIVE and absence.person_id in person_ids
        ]

        rows = [
            self._build_row(site, visible_days, assignments, absences, marks)
            for site in visible_sites
        ]
        return MatrixResponse(
            start_date=start,
            end_date=end,
            days=[self._build_day(day) for day in visible_days],
            rows=rows,
        )

    def get_site_cells(self, *, site_id: int, start: date, end: date) -> list[MatrixCell]:
        site = self.sites.get(site_id)
        if site is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustelle nicht gefunden.")
        days = self._date_range(start, end)
        assignments = self.assignments.list(start=start, end=end, site_id=site_id)
        person_ids = {assignment.person_id for assignment in assignments}
        absences = [
            absence
            for absence in self.absences.list(start=start, end=end)
            if absence.status == AbsenceStatus.ACTIVE and absence.person_id in person_ids
        ]
        marks = self._list_marks(site_ids={site_id}, start=start, end=end)
        return self._build_cells(days=days, site_id=site_id, assignments=assignments, absences=absences, marks=marks)

    def _build_row(
        self,
        site: Site,
        days: list[date],
        assignments: list[Assignment],
        absences,
        marks,
    ) -> MatrixRow:
        site_assignments = [
            assignment for assignment in assignments if assignment.site_id == site.id
        ]
        cells = self._build_cells(days=days, site_id=site.id, assignments=site_assignments, absences=absences, marks=marks)

        return MatrixRow(
            site=MatrixSite(
                id=site.id,
                site_number=site.site_number,
                name=site.name,
                location=site.location,
                customer=site.customer,
                project_manager_person_id=site.project_manager_person_id,
                project_manager=(
                    self._build_person(site.project_manager) if site.project_manager else None
                ),
                status=site.status,
                info=site.info,
                color=site.color,
            ),
            cells=cells,
        )

    def _build_cells(
        self,
        *,
        days: list[date],
        site_id: int,
        assignments: list[Assignment],
        absences,
        marks,
    ) -> list[MatrixCell]:
        cells = []
        for day in days:
            day_assignments = [
                assignment for assignment in assignments
                if assignment.start_date <= day <= assignment.end_date
            ]
            assigned_person_ids = {assignment.person_id for assignment in day_assignments}
            day_absences = [
                absence for absence in absences
                if absence.person_id in assigned_person_ids
                and absence.start_date <= day <= absence.end_date
            ]
            cells.append(
                MatrixCell(
                    date=day,
                    assignments=[self._build_assignment(item) for item in day_assignments],
                    absences=[self._build_absence(item) for item in day_absences],
                    mark=marks.get((site_id, day)),
                )
            )
        return cells


    def _list_marks(
        self,
        *,
        site_ids: set[int],
        start: date,
        end: date,
    ) -> dict[tuple[int, date], object]:
        if not site_ids:
            return {}
        statement = select(PlanningCellMark).where(
            PlanningCellMark.site_id.in_(site_ids),
            PlanningCellMark.mark_date >= start,
            PlanningCellMark.mark_date <= end,
        )
        return {
            (mark.site_id, mark.mark_date): mark.mark
            for mark in self.db.scalars(statement)
        }

    def _build_assignment(self, assignment: Assignment) -> MatrixAssignment:
        return MatrixAssignment(
            id=assignment.id,
            person=self._build_person(assignment.person),
            start_date=assignment.start_date,
            end_date=assignment.end_date,
            assignment_type=assignment.assignment_type,
            note=assignment.note,
        )

    def _build_absence(self, absence) -> MatrixAbsence:
        return MatrixAbsence(
            person=self._build_person(absence.person),
            absence_type=absence.absence_type,
            start_date=absence.start_date,
            end_date=absence.end_date,
            note=absence.note,
        )

    def _build_person(self, person: Person) -> MatrixPerson:
        return MatrixPerson(
            id=person.id,
            display_name=person.display_name,
            short_code=calendar_short_code(person),
            person_type=person.person_type,
        )

    def _build_day(self, day: date) -> MatrixDay:
        return MatrixDay(date=day, weekday=day.weekday(), is_weekend=day.weekday() >= 5)

    def _date_range(self, start: date, end: date) -> list[date]:
        return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
