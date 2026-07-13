from datetime import date, datetime, timedelta
from hashlib import sha1

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.dashboard_note import DashboardNote
from app.models.enums import AbsenceStatus
from app.models.person import Person
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.repositories.absence_repository import AbsenceRepository
from app.repositories.assignment_repository import AssignmentRepository
from app.repositories.site_repository import SiteRepository
from app.services.conflict_service import HARD_ABSENCE_TYPES, WARNING_ABSENCE_TYPES
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
    MatrixVersionResponse,
)

MAX_MATRIX_DAYS = 90
MAX_MATRIX_YEAR_VIEW_DAYS = 366


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
        year_view: bool = False,
        project_manager_person_id: int | None = None,
    ) -> MatrixResponse:
        if end < start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
        max_days = MAX_MATRIX_YEAR_VIEW_DAYS if year_view else MAX_MATRIX_DAYS
        if (end - start).days + 1 > max_days:
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

        all_visible_sites = self.sites.list(include_closed=include_closed)
        project_managers = self._build_project_managers(all_visible_sites)
        visible_sites = (
            all_visible_sites
            if project_manager_person_id is None
            else [
                site
                for site in all_visible_sites
                if site.project_manager_person_id == project_manager_person_id
            ]
        )
        site_ids = {site.id for site in visible_sites}
        open_note_counts = self._open_note_counts_by_site(site_ids=site_ids)
        assignments = [assignment for assignment in assignments if assignment.site_id in site_ids]
        marks = self._list_marks(site_ids=site_ids, start=start, end=end)
        person_ids = {assignment.person_id for assignment in assignments}
        absences = [
            absence
            for absence in self.absences.list(start=start, end=end)
            if absence.status == AbsenceStatus.ACTIVE and absence.person_id in person_ids
        ]
        assignments_by_site_date = self._index_assignments_by_site_date(assignments, visible_days)
        absences_by_date = self._index_absences_by_date(absences, visible_days)

        rows = [
            self._build_row(
                site,
                visible_days,
                assignments_by_site_date,
                absences_by_date,
                marks,
                open_note_count=open_note_counts.get(site.id, 0),
            )
            for site in visible_sites
        ]
        return MatrixResponse(
            start_date=start,
            end_date=end,
            days=[self._build_day(day) for day in visible_days],
            project_managers=project_managers,
            rows=rows,
        )

    def get_version(
        self,
        *,
        start: date,
        end: date,
        include_closed: bool = False,
        year_view: bool = False,
        project_manager_person_id: int | None = None,
    ) -> MatrixVersionResponse:
        self._validate_range(start=start, end=end, year_view=year_view)
        visible_sites = (
            self.sites.list(include_closed=include_closed)
            if project_manager_person_id is None
            else self.sites.list(
                include_closed=include_closed,
                project_manager_person_id=project_manager_person_id,
            )
        )
        site_ids = {site.id for site in visible_sites}
        assignment_statement = select(
            func.max(Assignment.updated_at),
            func.count(Assignment.id),
        ).where(
            Assignment.start_date <= end,
            Assignment.end_date >= start,
        )
        mark_statement = select(
            func.max(PlanningCellMark.updated_at),
            func.count(PlanningCellMark.id),
        ).where(
            PlanningCellMark.mark_date >= start,
            PlanningCellMark.mark_date <= end,
        )
        if site_ids:
            assignment_statement = assignment_statement.where(Assignment.site_id.in_(site_ids))
            mark_statement = mark_statement.where(PlanningCellMark.site_id.in_(site_ids))
        else:
            assignment_statement = assignment_statement.where(False)
            mark_statement = mark_statement.where(False)

        assignment_latest, assignment_count = self.db.execute(assignment_statement).one()
        mark_latest, mark_count = self.db.execute(mark_statement).one()
        assignments = self.assignments.list(start=start, end=end)
        if site_ids:
            assignments = [assignment for assignment in assignments if assignment.site_id in site_ids]
        else:
            assignments = []
        person_ids = {assignment.person_id for assignment in assignments}
        person_ids.update(
            site.project_manager_person_id
            for site in visible_sites
            if site.project_manager_person_id is not None
        )
        absence_statement = select(
            func.max(Absence.updated_at),
            func.count(Absence.id),
        ).where(
            Absence.status == AbsenceStatus.ACTIVE,
            Absence.start_date <= end,
            Absence.end_date >= start,
        )
        if person_ids:
            absence_statement = absence_statement.where(Absence.person_id.in_(person_ids))
        else:
            absence_statement = absence_statement.where(False)
        absence_latest, absence_count = self.db.execute(absence_statement).one()

        person_statement = select(
            func.max(Person.updated_at),
            func.count(Person.id),
        )
        if person_ids:
            person_statement = person_statement.where(Person.id.in_(person_ids))
        else:
            person_statement = person_statement.where(False)
        person_latest, person_count = self.db.execute(person_statement).one()

        site_statement = select(
            func.max(Site.updated_at),
            func.count(Site.id),
        )
        if site_ids:
            site_statement = site_statement.where(Site.id.in_(site_ids))
        else:
            site_statement = site_statement.where(False)
        site_latest, site_count = self.db.execute(site_statement).one()

        note_statement = select(
            func.max(DashboardNote.updated_at),
            func.count(DashboardNote.id),
        ).where(
            DashboardNote.completed.is_(False),
            DashboardNote.deleted_at.is_(None),
        )
        if site_ids:
            note_statement = note_statement.where(
                DashboardNote.site_id.in_(site_ids),
            )
        else:
            note_statement = note_statement.where(False)
        note_latest, note_count = self.db.execute(note_statement).one()

        audit_latest = self.db.scalar(
            select(func.max(AuditLog.created_at)).where(
                AuditLog.entity_type.in_(
                    ["assignment", "absence", "matrix", "matrix_cell_mark", "site"]
                )
            )
        )
        latest_updated_at = max_datetime(
            assignment_latest,
            absence_latest,
            person_latest,
            mark_latest,
            site_latest,
            note_latest,
            audit_latest,
        )
        version_source = "|".join(
            [
                start.isoformat(),
                end.isoformat(),
                str(project_manager_person_id or "all"),
                str(include_closed),
                str(year_view),
                datetime_token(assignment_latest),
                str(assignment_count or 0),
                datetime_token(absence_latest),
                str(absence_count or 0),
                datetime_token(person_latest),
                str(person_count or 0),
                datetime_token(mark_latest),
                str(mark_count or 0),
                datetime_token(site_latest),
                str(site_count or 0),
                datetime_token(note_latest),
                str(note_count or 0),
                datetime_token(audit_latest),
            ]
        )
        return MatrixVersionResponse(
            version=sha1(version_source.encode("utf-8")).hexdigest(),
            latest_updated_at=latest_updated_at,
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
        assignments_by_site_date = self._index_assignments_by_site_date(assignments, days)
        absences_by_date = self._index_absences_by_date(absences, days)
        return self._build_cells(
            days=days,
            site_id=site_id,
            assignments_by_site_date=assignments_by_site_date,
            absences_by_date=absences_by_date,
            marks=marks,
        )

    def _build_row(
        self,
        site: Site,
        days: list[date],
        assignments_by_site_date: dict[tuple[int, date], list[Assignment]],
        absences_by_date: dict[date, list[Absence]],
        marks,
        *,
        open_note_count: int = 0,
    ) -> MatrixRow:
        cells = self._build_cells(
            days=days,
            site_id=site.id,
            assignments_by_site_date=assignments_by_site_date,
            absences_by_date=absences_by_date,
            marks=marks,
        )

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
                open_note_count=open_note_count,
            ),
            cells=cells,
        )

    def _build_cells(
        self,
        *,
        days: list[date],
        site_id: int,
        assignments_by_site_date: dict[tuple[int, date], list[Assignment]],
        absences_by_date: dict[date, list[Absence]],
        marks,
    ) -> list[MatrixCell]:
        cells = []
        for day in days:
            day_assignments = assignments_by_site_date.get((site_id, day), [])
            assigned_person_ids = {assignment.person_id for assignment in day_assignments}
            day_absences = [
                absence for absence in absences_by_date.get(day, [])
                if absence.person_id in assigned_person_ids
            ]
            cells.append(
                MatrixCell(
                    date=day,
                    assignments=[self._build_assignment(item) for item in day_assignments],
                    absences=[self._build_absence(item) for item in day_absences],
                    mark=marks.get((site_id, day)),
                    **self._cell_conflict_flags(day_absences),
                )
            )
        return cells

    def _open_note_counts_by_site(
        self,
        *,
        site_ids: set[int],
    ) -> dict[int, int]:
        if not site_ids:
            return {}
        statement = (
            select(DashboardNote.site_id, func.count(DashboardNote.id))
            .where(
                DashboardNote.site_id.in_(site_ids),
                DashboardNote.completed.is_(False),
                DashboardNote.deleted_at.is_(None),
            )
            .group_by(DashboardNote.site_id)
        )
        return {
            site_id: count
            for site_id, count in self.db.execute(statement)
            if site_id is not None
        }

    def _index_assignments_by_site_date(
        self,
        assignments: list[Assignment],
        days: list[date],
    ) -> dict[tuple[int, date], list[Assignment]]:
        if not days:
            return {}
        visible_days = set(days)
        start = days[0]
        end = days[-1]
        indexed: dict[tuple[int, date], list[Assignment]] = {}
        for assignment in assignments:
            for day in self._date_range(
                max(assignment.start_date, start),
                min(assignment.end_date, end),
            ):
                if day in visible_days:
                    indexed.setdefault((assignment.site_id, day), []).append(assignment)
        return indexed

    def _index_absences_by_date(
        self,
        absences: list[Absence],
        days: list[date],
    ) -> dict[date, list[Absence]]:
        if not days:
            return {}
        visible_days = set(days)
        start = days[0]
        end = days[-1]
        indexed: dict[date, list[Absence]] = {}
        for absence in absences:
            for day in self._date_range(
                max(absence.start_date, start),
                min(absence.end_date, end),
            ):
                if day in visible_days:
                    indexed.setdefault(day, []).append(absence)
        return indexed


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

    def _cell_conflict_flags(self, absences) -> dict:
        if not absences:
            return {
                "conflict_level": "none",
                "conflict_reason": None,
                "conflict_codes": [],
            }
        hard_absences = [absence for absence in absences if absence.absence_type in HARD_ABSENCE_TYPES]
        warning_absences = [absence for absence in absences if absence.absence_type in WARNING_ABSENCE_TYPES]
        if hard_absences:
            labels = sorted({self._absence_label(absence.absence_type) for absence in hard_absences})
            return {
                "conflict_level": "hard",
                "conflict_reason": " + ".join(labels) + " am Einsatztag",
                "conflict_codes": sorted({f"absence_{absence.absence_type.value}" for absence in hard_absences}),
            }
        if warning_absences:
            labels = sorted({self._absence_label(absence.absence_type) for absence in warning_absences})
            return {
                "conflict_level": "warning",
                "conflict_reason": " + ".join(labels) + " am Einsatztag",
                "conflict_codes": sorted({f"absence_{absence.absence_type.value}" for absence in warning_absences}),
            }
        return {
            "conflict_level": "none",
            "conflict_reason": None,
            "conflict_codes": [],
        }

    def _absence_label(self, absence_type) -> str:
        labels = {
            "vacation": "Urlaub",
            "sick": "Krankheit",
            "school": "Schule",
            "free": "Überstunden",
            "other": "Abwesenheit",
        }
        return labels.get(absence_type.value, "Abwesenheit")

    def _build_person(self, person: Person) -> MatrixPerson:
        return MatrixPerson(
            id=person.id,
            display_name=person.display_name,
            short_code=calendar_short_code(person),
            person_type=person.person_type,
        )

    def _build_project_managers(self, sites: list[Site]) -> list[MatrixPerson]:
        people_by_id = {
            site.project_manager.id: site.project_manager
            for site in sites
            if site.project_manager is not None
        }
        return [
            self._build_person(person)
            for person in sorted(
                people_by_id.values(),
                key=lambda person: (person.display_name, person.id),
            )
        ]

    def _build_day(self, day: date) -> MatrixDay:
        return MatrixDay(date=day, weekday=day.weekday(), is_weekend=day.weekday() >= 5)

    def _date_range(self, start: date, end: date) -> list[date]:
        return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]

    def _validate_range(self, *, start: date, end: date, year_view: bool) -> None:
        if end < start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")
        max_days = MAX_MATRIX_YEAR_VIEW_DAYS if year_view else MAX_MATRIX_DAYS
        if (end - start).days + 1 > max_days:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Matrixzeitraum ist zu gross.")


def datetime_token(value: datetime | None) -> str:
    return value.isoformat() if value is not None else ""


def max_datetime(*values: datetime | None) -> datetime | None:
    present_values = [value for value in values if value is not None]
    return max(present_values) if present_values else None
