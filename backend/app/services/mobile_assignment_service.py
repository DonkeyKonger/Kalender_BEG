from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.enums import AssignmentType, SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.assignment import AssignmentCreate
from app.schemas.mobile import (
    MobileAssignment,
    MobileAssignmentsResponse,
    MobilePerson,
    MobileSelfPlanRequest,
    MobileSite,
)
from app.services.assignment_service import AssignmentService

MAX_DEFAULT_DAYS = 45
MAX_HISTORY_DAYS = 370
MAX_RECENT_SITES = 20
SELF_PLANNED_NOTE = "Vom Monteur selbst nachgetragen, weil keine Planung vorhanden war."


class MobileAssignmentService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_own_assignments(
        self,
        *,
        current_user: User,
        start: date,
        end: date,
        allow_history: bool = False,
    ) -> MobileAssignmentsResponse:
        if current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )
        if end < start:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enddatum liegt vor Startdatum.")

        max_days = MAX_HISTORY_DAYS if allow_history else MAX_DEFAULT_DAYS
        if (end - start).days + 1 > max_days:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Der angefragte Zeitraum ist fuer diese Ansicht zu gross.",
            )

        statement = (
            select(Assignment)
            .options(
                selectinload(Assignment.person),
                selectinload(Assignment.site).selectinload(Site.project_manager),
            )
            .where(
                Assignment.person_id == current_user.person_id,
                Assignment.start_date <= end,
                Assignment.end_date >= start,
            )
            .order_by(Assignment.start_date, Assignment.end_date, Assignment.id)
        )
        assignments = list(self.db.scalars(statement))
        return MobileAssignmentsResponse(
            start_date=start,
            end_date=end,
            assignments=[self._build_assignment(item) for item in assignments],
        )

    def list_active_sites_for_mobile(self, *, current_user: User) -> list[MobileSite]:
        if current_user.role == UserRole.MONTEUR and current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )

        statement = (
            select(Site)
            .options(selectinload(Site.project_manager))
            .where(Site.status == SiteStatus.ACTIVE)
            .order_by(Site.site_number, Site.name, Site.id)
        )
        return [self._build_site(site) for site in self.db.scalars(statement)]

    def list_recently_planned_sites(
        self,
        *,
        current_user: User,
        months: int = 12,
    ) -> list[MobileSite]:
        if current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )

        bounded_months = min(max(months, 1), 24)
        since = date.today() - timedelta(days=bounded_months * 31)
        latest_assignment = (
            select(
                Assignment.site_id.label("site_id"),
                func.max(Assignment.end_date).label("last_planned_date"),
            )
            .where(
                Assignment.person_id == current_user.person_id,
                Assignment.end_date >= since,
            )
            .group_by(Assignment.site_id)
            .subquery()
        )
        statement = (
            select(Site)
            .join(latest_assignment, Site.id == latest_assignment.c.site_id)
            .options(selectinload(Site.project_manager))
            .where(Site.status.not_in([SiteStatus.COMPLETED, SiteStatus.DELETED]))
            .order_by(latest_assignment.c.last_planned_date.desc(), Site.name, Site.id)
            .limit(MAX_RECENT_SITES)
        )
        return [self._build_site(site) for site in self.db.scalars(statement)]

    def self_plan_assignment(
        self,
        *,
        current_user: User,
        payload: MobileSelfPlanRequest,
    ) -> MobileAssignment:
        if current_user.role != UserRole.MONTEUR:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Nur Monteure koennen Einsaetze mobil selbst nachtragen.",
            )
        if current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )

        site = self.db.scalar(
            select(Site)
            .options(selectinload(Site.project_manager))
            .where(Site.id == payload.site_id)
        )
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")

        was_previously_planned = self.db.scalar(
            select(Assignment.id)
            .where(
                Assignment.person_id == current_user.person_id,
                Assignment.site_id == payload.site_id,
                Assignment.end_date < payload.work_date,
            )
            .limit(1)
        ) is not None
        if site.status != SiteStatus.ACTIVE and not was_previously_planned:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Diese Baustelle kann mobil nicht nachgetragen werden.",
            )

        existing_assignment = self.db.scalar(
            select(Assignment)
            .options(
                selectinload(Assignment.person),
                selectinload(Assignment.site).selectinload(Site.project_manager),
            )
            .where(
                Assignment.person_id == current_user.person_id,
                Assignment.site_id == payload.site_id,
                Assignment.start_date <= payload.work_date,
                Assignment.end_date >= payload.work_date,
            )
            .limit(1)
        )
        if existing_assignment is not None:
            return self._build_assignment(existing_assignment)

        result = AssignmentService(self.db).create_assignment(
            AssignmentCreate(
                site_id=payload.site_id,
                person_id=current_user.person_id,
                start_date=payload.work_date,
                end_date=payload.work_date,
                assignment_type=AssignmentType.SELF_PLANNED,
                note=SELF_PLANNED_NOTE,
            ),
            user_id=current_user.id,
            audit_action="assignment.mobile_self_planned",
        )
        return self._build_assignment(result.assignment)

    def _build_assignment(self, assignment: Assignment) -> MobileAssignment:
        return MobileAssignment(
            id=assignment.id,
            start_date=assignment.start_date,
            end_date=assignment.end_date,
            assignment_type=assignment.assignment_type,
            note=assignment.note,
            person=self._build_person(assignment.person),
            site=self._build_site(assignment.site),
        )

    def _build_site(self, site: Site) -> MobileSite:
        return MobileSite(
            id=site.id,
            site_number=site.site_number,
            name=site.name,
            location=site.location,
            address=site.address,
            customer=site.customer,
            project_manager=self._build_person(site.project_manager) if site.project_manager else None,
            status=site.status,
            info=site.info,
        )

    def _build_person(self, person: Person) -> MobilePerson:
        return MobilePerson(
            id=person.id,
            display_name=person.display_name,
            phone=person.phone,
            email=person.email,
            can_sign_measurements_immediately=person.can_sign_measurements_immediately,
        )
