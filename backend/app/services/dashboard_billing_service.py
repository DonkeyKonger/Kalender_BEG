"""Read-only billing queue. Completion and invoicing are independent states."""
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.enums import MeasurementBatchOrigin, SiteStatus, UserRole
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.user import User
from app.schemas.dashboard_billing import (
    DashboardBillingItemRead, DashboardBillingRead, DashboardBillingSiteRead,
)
from app.services.measurement_status_history import COMPLETED_STATUSES, SIGNED_STATUSES


BILLING_STATUSES = {"submitted", "in_review", "reviewed", "checked"} | SIGNED_STATUSES | COMPLETED_STATUSES


def billing_status_label(value: str, signed_at) -> str:
    if value in COMPLETED_STATUSES:
        return "Abgeschlossen"
    if value in SIGNED_STATUSES or signed_at:
        return "Unterschrieben"
    if value in {"reviewed", "checked"}:
        return "Geprüft"
    return "Eingereicht"


class DashboardBillingService:
    def __init__(self, db: Session):
        self.db = db

    def get_overview(self, *, current_user: User) -> DashboardBillingRead:
        if current_user.role not in {UserRole.ADMIN, UserRole.PROJECT_MANAGER}:
            raise HTTPException(403, "Keine Berechtigung für die Abrechnungsübersicht.")
        # An unlinked manager must never see unassigned sites as their own.
        if current_user.role == UserRole.PROJECT_MANAGER and current_user.person_id is None:
            return DashboardBillingRead(open_count=0, sites=[])

        groups: dict[int, DashboardBillingSiteRead] = {}
        site_columns = (Site.id.label("site_id"), Site.site_number, Site.name.label("site_name"),
                        Person.display_name.label("project_manager_name"))
        # Project scalar fields only: no positions, signatures, snapshots or N+1 loads.
        # Combined measurements are derived headers, not additional billable records.
        for model, kind, number_column, extra_columns in (
            (SiteMeasurementBatch, "measurement", SiteMeasurementBatch.number,
             (SiteMeasurementBatch.area_location, SiteMeasurementBatch.origin, SiteMeasurementBatch.measurement_date)),
            (ExtraWorkTicket, "extra_work", ExtraWorkTicket.sequence_number,
             (ExtraWorkTicket.display_number,)),
        ):
            statement = (
                select(*site_columns, model.id, model.title, model.status, model.submitted_at,
                       model.created_at, model.customer_signed_at, number_column.label("number"), *extra_columns)
                .join(Site, Site.id == model.site_id)
                .outerjoin(Person, Person.id == Site.project_manager_person_id)
                .where(model.is_invoiced.is_(False), model.deleted_at.is_(None), Site.status != SiteStatus.DELETED,
                       func.lower(func.trim(model.status)).in_(BILLING_STATUSES))
                .order_by(Site.id, number_column.desc(), model.id.desc())
            )
            if current_user.role == UserRole.PROJECT_MANAGER:
                statement = statement.where(Site.project_manager_person_id == current_user.person_id)
            for row in self.db.execute(statement).mappings():
                group = groups.setdefault(row["site_id"], DashboardBillingSiteRead(
                    site_id=row["site_id"], site_number=row["site_number"], site_name=row["site_name"],
                    project_manager_name=row["project_manager_name"], items=[],
                ))
                if kind == "measurement":
                    site_number = (row["site_number"] or "").strip()
                    title = f"Aufmaß {site_number}.{row['number']:02d}" if site_number else row["title"]
                    hint = " ".join((row["area_location"] or "").split()) if row["origin"] == MeasurementBatchOrigin.OFFICE else ""
                    if hint:
                        title += f" - {hint}"
                    item_date = row["measurement_date"]
                else:
                    title = f"Zusatzauftrag {row['display_number']}"
                    item_date = None
                timestamp = row["submitted_at"] or row["created_at"]
                normalized_status = row["status"].strip().lower()
                group.items.append(DashboardBillingItemRead(
                    id=row["id"], kind=kind, title=title, status=normalized_status,
                    status_label=billing_status_label(normalized_status, row["customer_signed_at"]),
                    date=item_date or (timestamp.date() if timestamp else None),
                ))

        sites = sorted(groups.values(), key=lambda group: (group.site_name.casefold(), group.site_number or "", group.site_id))
        return DashboardBillingRead(open_count=sum(len(group.items) for group in sites), sites=sites)
