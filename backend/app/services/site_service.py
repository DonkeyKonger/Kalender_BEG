from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.customer import Customer
from app.models.enums import SiteLocationStatus, SiteStatus
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.models.vehicle import SiteVehicleAssignment
from app.repositories.person_repository import PersonRepository
from app.repositories.site_repository import SiteRepository
from app.schemas.site import SiteCreate, SiteMapItem, SiteMapResponse, SiteUpdate
from app.services.audit_service import AuditService
from app.services.geo_service import (
    DEFAULT_SITE_GEOFENCE_RADIUS_M,
    geocode_site_address,
    has_valid_coordinates,
)
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import (
    PROJECT_FOLDER_STATUS_CREATED,
    PROJECT_FOLDER_STATUS_DISABLED,
    ProjectStorageService,
)


OPTIONAL_TEXT_FIELDS = [
    "site_number",
    "location",
    "address",
    "postal_code",
    "city",
    "street",
    "house_number",
    "address_extra",
    "customer",
    "info",
    "color",
]
CLOSED_STATUSES = {SiteStatus.COMPLETED, SiteStatus.DELETED}
OPEN_STATUSES = {SiteStatus.ACTIVE, SiteStatus.PAUSED, SiteStatus.PLANNED}
PROJECT_FOLDER_BACKFILL_DEFAULT_LIMIT = 10
PROJECT_FOLDER_BACKFILL_MAX_LIMIT = 25
ADDRESS_FIELDS = {"address", "postal_code", "city", "street", "house_number", "address_extra"}
TECHNICAL_LOCATION_FIELDS = {"latitude", "longitude", "location_status"}
PROJECT_FOLDER_SYNC_FIELDS = {"name", "project_manager_person_id", "site_number", "status"}
VALID_MAP_LOCATION_STATUSES = {SiteLocationStatus.GEOCODED}
SITE_LOCATION_DEPENDENCY_FIELDS = (
    "location",
    "address",
    "postal_code",
    "city",
    "street",
    "house_number",
    "address_extra",
    "latitude",
    "longitude",
)


class SiteService:
    def __init__(self, db: Session, project_storage: ProjectStorageService | None = None) -> None:
        self.db = db
        self.sites = SiteRepository(db)
        self.people = PersonRepository(db)
        self.audit = AuditService(db)
        self.project_storage = project_storage or ProjectStorageService()

    def list_sites(self, include_closed: bool = False) -> list[Site]:
        return self.sites.list(include_closed=include_closed)

    def list_site_summaries(self, include_closed: bool = False) -> list[Site]:
        return self.sites.list_summary(include_closed=include_closed)

    def site_map(self) -> SiteMapResponse:
        map_sites = []
        missing_location = 0
        for site in self.sites.list(include_closed=False):
            if has_valid_map_location(site):
                map_sites.append(site_map_item(site))
            else:
                missing_location += 1
        return SiteMapResponse(sites=map_sites, missing_location=missing_location)

    def get_site(self, site_id: int, *, include_deleted: bool = False) -> Site:
        site = self.sites.get(site_id, include_deleted=include_deleted)
        if site is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Baustelle nicht gefunden oder gelöscht.",
            )
        return site

    def remove_plan(self, site_id: int) -> str:
        self.get_site(site_id, include_deleted=True)
        return "delete"

    def remove_site(self, site_id: int, user_id: int) -> tuple[str, Site | None]:
        site = self.get_site(site_id, include_deleted=True)
        if site.status == SiteStatus.DELETED:
            return "deleted", site
        old_value = site_snapshot(site)
        site.status = SiteStatus.DELETED
        self._apply_status_metadata(site, SiteStatus.DELETED, user_id)
        self._sync_project_folder_for_site(site)
        self.audit.record(
            user_id=user_id,
            action="site.deleted",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return "deleted", site

    def archive_site(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id)
        if site.status == SiteStatus.COMPLETED:
            return site
        old_value = site_snapshot(site)
        site.status = SiteStatus.COMPLETED
        self._apply_status_metadata(site, SiteStatus.COMPLETED, user_id)
        self._sync_project_folder_for_site(site)
        self.audit.record(
            user_id=user_id,
            action="site.completed",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def _site_has_dependencies(self, site: Site) -> bool:
        if any(
            getattr(site, field, None) not in (None, "")
            for field in SITE_LOCATION_DEPENDENCY_FIELDS
        ):
            return True
        return (
            self._has_row(Assignment, Assignment.site_id == site.id)
            or self._has_row(PlanningCellMark, PlanningCellMark.site_id == site.id)
            or self._has_row(SiteVehicleAssignment, SiteVehicleAssignment.site_id == site.id)
            or self._has_row(
                AuditLog,
                AuditLog.entity_type == "site",
                AuditLog.entity_id == site.id,
                AuditLog.action != "site.created",
            )
        )

    def _has_row(self, model, *criteria) -> bool:
        statement = select(model.id).where(*criteria).limit(1)
        return self.db.scalar(statement) is not None

    def create_site(self, payload: SiteCreate, user_id: int) -> Site:
        values = clean_site_values(payload.model_dump())
        validate_site_create_values(values)
        self._ensure_project_manager_exists(values.get("project_manager_person_id"))
        self._apply_customer_reference(values)
        self._ensure_site_number_available(values.get("site_number"))
        apply_selected_geocode(values)
        site = Site(**values)
        self._apply_status_metadata(site, site.status, user_id)
        self.sites.add(site)
        self.db.flush()
        ProjectFolderService(self.db).create_default_project_folders_for_site(site.id)
        self._sync_project_folder_for_site(site, force=True)
        self.audit.record(
            user_id=user_id,
            action="site.created",
            entity_type="site",
            entity_id=site.id,
            old_value=None,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def backfill_project_folders(self, limit: int = PROJECT_FOLDER_BACKFILL_DEFAULT_LIMIT) -> dict:
        self._ensure_project_folder_creation_enabled()
        safe_limit = max(1, min(limit, PROJECT_FOLDER_BACKFILL_MAX_LIMIT))
        candidates = self.db.scalars(select(Site).order_by(Site.id)).all()
        skipped = []

        created = []
        errors = []
        for site in candidates[:safe_limit]:
            self._sync_project_folder_for_site(site, force=True)
            if site.project_folder_status == PROJECT_FOLDER_STATUS_CREATED:
                created.append(backfill_site_result(site))
            elif site.project_folder_status == PROJECT_FOLDER_STATUS_DISABLED:
                skipped.append(backfill_site_result(site, reason="disabled"))
            else:
                errors.append(
                    backfill_site_result(
                        site,
                        safe_error=site.project_folder_error or "Project folder creation failed.",
                    )
                )

        for site in candidates[safe_limit:]:
            skipped.append(backfill_site_result(site, reason="limit_reached"))

        self.db.commit()
        return {
            "total_candidates": len(candidates),
            "created_count": len(created),
            "skipped_count": len(skipped),
            "error_count": len(errors),
            "created": created,
            "skipped": skipped,
            "errors": errors,
        }

    def update_site(self, site_id: int, payload: SiteUpdate, user_id: int) -> Site:
        site = self.sites.get(site_id, include_deleted=True)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")

        values = clean_site_values(payload.model_dump(exclude_unset=True))
        self._ensure_project_manager_exists(values.get("project_manager_person_id"))
        self._apply_customer_reference(values)
        old_value = site_snapshot(site)
        address_changed = any(
            field in values and getattr(site, field) != values[field] for field in ADDRESS_FIELDS
        )
        project_folder_sync_needed = any(field in values for field in PROJECT_FOLDER_SYNC_FIELDS)
        selected_geocode = apply_selected_geocode(values)
        status_value = values.get("status")
        if status_value is not None:
            self._apply_status_metadata(site, status_value, user_id)
        for field, value in values.items():
            setattr(site, field, value)
        if address_changed and not selected_geocode:
            site.latitude = None
            site.longitude = None
            site.location_status = SiteLocationStatus.UNCHECKED
        if project_folder_sync_needed:
            self._sync_project_folder_for_site(site)
        self.audit.record(
            user_id=user_id,
            action="site.updated",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def close_site(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id)
        if site.status == SiteStatus.COMPLETED:
            return site
        old_value = site_snapshot(site)
        site.status = SiteStatus.COMPLETED
        self._apply_status_metadata(site, SiteStatus.COMPLETED, user_id)
        self._sync_project_folder_for_site(site)
        self.audit.record(
            user_id=user_id,
            action="site.completed",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def reactivate_site(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id, include_deleted=True)
        if site.status == SiteStatus.ACTIVE and site.closed_at is None:
            return site
        old_value = site_snapshot(site)
        site.status = SiteStatus.ACTIVE
        self._apply_status_metadata(site, SiteStatus.ACTIVE, user_id)
        self._sync_project_folder_for_site(site)
        self.audit.record(
            user_id=user_id,
            action="site.reactivated",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def check_location(self, site_id: int, user_id: int) -> Site:
        site = self.get_site(site_id)
        if site.location_status == SiteLocationStatus.GEOCODED and has_valid_coordinates(site):
            return site
        old_value = site_snapshot(site)
        candidates = geocode_site_address(site)
        if len(candidates) == 1:
            candidate = candidates[0]
            site.latitude = candidate.latitude
            site.longitude = candidate.longitude
            site.location_status = SiteLocationStatus.GEOCODED
        elif len(candidates) > 1:
            site.location_status = SiteLocationStatus.AMBIGUOUS
        else:
            site.location_status = SiteLocationStatus.FAILED
        self.audit.record(
            user_id=user_id,
            action="site.location_checked",
            entity_type="site",
            entity_id=site.id,
            old_value=old_value,
            new_value=site_snapshot(site),
        )
        self.db.commit()
        self.db.refresh(site)
        return site

    def _apply_status_metadata(self, site: Site, status_value: SiteStatus, user_id: int) -> None:
        if status_value in CLOSED_STATUSES:
            if site.closed_at is None:
                site.closed_at = datetime.now(UTC)
            site.closed_by_user_id = user_id
        if status_value in OPEN_STATUSES:
            site.closed_at = None
            site.closed_by_user_id = None

    def _ensure_project_folder_creation_enabled(self) -> None:
        if not self.project_storage.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not self.project_storage.config.ms_graph_create_project_folders_enabled:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED is false."
            )

    def _sync_project_folder_for_site(self, site: Site, *, force: bool = False) -> dict | None:
        if not force and not self._project_folder_sync_enabled():
            return None
        result = self.project_storage.sync_project_folder_for_site(
            site_id=site.id,
            site_number=site.site_number,
            site_name=site.name,
            project_manager_name=self._project_manager_folder_name(site),
            project_manager_id=site.project_manager_person_id,
            is_archived=site.status in CLOSED_STATUSES,
            existing_folder_id=site.project_folder_id,
        )
        self._apply_project_folder_result(site, result)
        return result

    def _project_folder_sync_enabled(self) -> bool:
        return bool(
            self.project_storage.config.ms_graph_enabled
            and self.project_storage.config.ms_graph_create_project_folders_enabled
        )

    def _project_manager_folder_name(self, site: Site) -> str | None:
        if site.project_manager_person_id is None:
            project_manager = getattr(site, "project_manager", None)
            return project_manager.display_name if project_manager is not None else None
        person = self.people.get(site.project_manager_person_id, include_deleted=True)
        return person.display_name if person is not None else None

    def _apply_project_folder_result(self, site: Site, result: dict) -> None:
        site.project_folder_status = result.get("status") or "not_configured"
        if result.get("folder_id") is not None or site.project_folder_id is None:
            site.project_folder_id = result.get("folder_id")
        if result.get("web_url") is not None or site.project_folder_web_url is None:
            site.project_folder_web_url = result.get("web_url")
        if result.get("folder_name") is not None or site.project_folder_name is None:
            site.project_folder_name = result.get("folder_name")
        site.project_folder_error = result.get("error")
        if site.project_folder_status != PROJECT_FOLDER_STATUS_CREATED:
            return
        subfolders = result.get("subfolders")
        if not isinstance(subfolders, list):
            return
        ProjectFolderService(self.db).attach_external_subfolders_for_site(
            site.id,
            subfolders,
            drive_id=result.get("drive_id"),
        )

    def _ensure_project_manager_exists(self, person_id: int | None) -> None:
        if person_id is not None and self.people.get(person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Projektleiter-Person nicht gefunden.")

    def _apply_customer_reference(self, values: dict) -> None:
        if "customer_id" not in values or values.get("customer_id") is None:
            return
        customer = self.db.get(Customer, values["customer_id"])
        if customer is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kunde nicht gefunden.")
        values["customer"] = customer.company_name

    def _ensure_site_number_available(self, site_number: str | None) -> None:
        if site_number is None:
            return
        existing_id = self.db.scalar(select(Site.id).where(Site.site_number == site_number).limit(1))
        if existing_id is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Kommissionsnummer ist bereits vorhanden.")


def clean_site_values(values: dict) -> dict:
    cleaned = dict(values)
    if isinstance(cleaned.get("name"), str):
        cleaned["name"] = cleaned["name"].strip()
    for field in OPTIONAL_TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if "geofence_radius_m" in cleaned and cleaned.get("geofence_radius_m") is None:
        cleaned["geofence_radius_m"] = DEFAULT_SITE_GEOFENCE_RADIUS_M
    if "name" in cleaned and not cleaned.get("name"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustellenname darf nicht leer sein.")
    return cleaned


def validate_site_create_values(values: dict) -> None:
    if not values.get("name"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustellenname fehlt.")
    if not values.get("site_number"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kommissionsnummer fehlt.")
    if values.get("project_manager_person_id") is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Projektleiter fehlt.")
    if values.get("status") is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status fehlt.")
    if not values.get("color"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Farbe fehlt.")


def backfill_site_result(
    site: Site, *, reason: str | None = None, safe_error: str | None = None
) -> dict:
    result = {
        "site_id": site.id,
        "site_number": site.site_number,
        "site_name": site.name,
    }
    if reason is not None:
        result["reason"] = reason
    if safe_error is not None:
        result["safe_error"] = safe_error[:240]
    if site.project_folder_name is not None:
        result["folder_name"] = site.project_folder_name
    if site.project_folder_web_url is not None:
        result["web_url"] = site.project_folder_web_url
    return result


def site_snapshot(site: Site) -> dict:
    return {
        "id": site.id,
        "site_number": site.site_number,
        "name": site.name,
        "location": site.location,
        "address": site.address,
        "postal_code": site.postal_code,
        "city": site.city,
        "street": site.street,
        "house_number": site.house_number,
        "address_extra": site.address_extra,
        "latitude": site.latitude,
        "longitude": site.longitude,
        "geofence_radius_m": site.geofence_radius_m,
        "location_status": site.location_status.value,
        "customer": site.customer,
        "customer_id": getattr(site, "customer_id", None),
        "project_manager_person_id": site.project_manager_person_id,
        "status": site.status.value,
        "info": site.info,
        "color": site.color,
        "planned_work_minutes": site.planned_work_minutes,
        "project_folder_id": getattr(site, "project_folder_id", None),
        "project_folder_web_url": getattr(site, "project_folder_web_url", None),
        "project_folder_name": getattr(site, "project_folder_name", None),
        "project_folder_status": getattr(site, "project_folder_status", "not_configured"),
        "project_folder_error": getattr(site, "project_folder_error", None),
        "closed_at": site.closed_at.isoformat() if site.closed_at else None,
        "closed_by_user_id": site.closed_by_user_id,
    }


def has_valid_map_location(site: Site) -> bool:
    return (
        site.latitude is not None
        and site.longitude is not None
        and site.location_status in VALID_MAP_LOCATION_STATUSES
    )


def site_map_item(site: Site) -> SiteMapItem:
    return SiteMapItem(
        id=site.id,
        name=site.name,
        number=site.site_number,
        city=site.city or site.location,
        postal_code=site.postal_code,
        street=site.street,
        house_number=site.house_number,
        project_manager=site.project_manager,
        status=site.status,
        color=site.color,
        latitude=site.latitude,
        longitude=site.longitude,
        geofence_radius_m=site.geofence_radius_m,
        location_status=site.location_status,
    )


def apply_selected_geocode(values: dict) -> bool:
    if values.get("location_status") == SiteLocationStatus.GEOCODED and has_valid_coordinates(
        CoordinateDraft(values.get("latitude"), values.get("longitude"))
    ):
        return True
    had_location_status = "location_status" in values
    for field in TECHNICAL_LOCATION_FIELDS:
        values.pop(field, None)
    if had_location_status:
        values["location_status"] = SiteLocationStatus.UNCHECKED
    return False


class CoordinateDraft:
    def __init__(self, latitude: float | None, longitude: float | None) -> None:
        self.latitude = latitude
        self.longitude = longitude
