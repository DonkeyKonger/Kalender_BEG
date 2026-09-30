from fastapi import HTTPException
from sqlalchemy import func, literal, select, update

from app.models.audit_log import AuditLog
from app.models.person import Person
from app.models.project_manager_folder import ProjectManagerFolder
from app.models.project_folder import ProjectFolder
from app.models.extra_work_ticket import ExtraWorkTicketPhoto
from app.models.site_measurement_item import SiteMeasurementBatchPhoto
from app.models.site import Site
from app.services.project_storage_service import (
    ProjectStorageService, make_project_manager_folder_name, PROJECT_FOLDER_ARCHIVE_FOLDER_NAME,
)


def sync_manager_rename(db, person, previous_name, *, storage=None):
    """Rename existing active/archive containers only; retries use persisted audit names."""
    storage = storage or ProjectStorageService(db=db)
    if not (storage.config.ms_graph_enabled and storage.config.ms_graph_create_project_folders_enabled):
        return []
    sites = db.scalars(select(Site).where(Site.project_manager_person_id == person.id)).all()
    binding = db.scalar(select(ProjectManagerFolder.id).where(ProjectManagerFolder.person_id == person.id).limit(1))
    if not sites and binding is None:
        return []
    errors = []
    root = storage.config.ms_project_root_folder_id
    for archived in (False, True):
        try:
            if storage._missing_project_config():
                raise HTTPException(503, "OneDrive-Konfiguration für den Ordnerabgleich fehlt.")
            parent_id = root
            if archived:
                archive = storage._find_child_folder(root, PROJECT_FOLDER_ARCHIVE_FOLDER_NAME)
                if archive is None:
                    continue
                parent_id = archive["id"]
            storage.resolve_project_manager_folder(
                person_id=person.id, parent_id=parent_id,
                name=make_project_manager_folder_name(project_manager_name=person.display_name, project_manager_id=person.id),
                previous_name=previous_name, create=False,
            )
        except HTTPException as error:
            errors.append(str(error.detail))
    if errors:
        for site in sites:
            site.project_folder_status = "error"
            site.project_folder_error = "Projektleiterordner: " + "; ".join(errors)
    return errors


def resolve_manager_folder(storage, db, *, person_id, parent_id, name, create=True, previous_name=None):
    """Reuse identity across renames. Never merge, replace or delete ambiguous folders."""
    # Serialize the first binding and subsequent renames for this person in PostgreSQL.
    person = db.scalar(select(Person).where(Person.id == person_id).with_for_update()
                       .execution_options(populate_existing=True))
    if person is None:
        raise HTTPException(409, "Projektleiter für die Ordnerzuordnung fehlt.")
    name = make_project_manager_folder_name(project_manager_name=person.display_name, project_manager_id=person.id)
    drive_id = storage.config.ms_project_drive_id
    binding = db.scalar(select(ProjectManagerFolder).where(
        ProjectManagerFolder.person_id == person_id,
        ProjectManagerFolder.drive_id == drive_id,
        ProjectManagerFolder.parent_folder_id == parent_id,
    ))
    def normalized(value):
        return make_project_manager_folder_name(project_manager_name=value).casefold()
    other_names = {normalized(value) for value in db.scalars(select(Person.display_name).where(Person.id != person_id))}
    if name.casefold() in other_names or name.casefold() in {"archiv", "ohne_projektleiter"}:
        raise HTTPException(409, "Projektleiter-Ordnername ist nicht eindeutig. Bitte Zuordnung prüfen.")

    current = None
    if binding:
        current = storage._try_get_drive_item(binding.folder_id)
        if current is None or not isinstance(current.get("folder"), dict):
            # A missing known folder may be in the recycle bin. Do not silently replace it.
            raise HTTPException(409, "Verknüpfter Projektleiterordner fehlt. Bitte OneDrive-Zuordnung prüfen.")
        if current.get("parentReference", {}).get("id") != parent_id:
            raise HTTPException(409, "Projektleiterordner wurde extern verschoben. Bitte Zuordnung prüfen.")

    candidates = storage._folder_children(parent_id)
    target = next((item for item in candidates if item["name"].casefold() == name.casefold()), None)
    if not binding and target is not None:
        # Bootstrap old installations using the current calendar name. Legacy
        # aliases may still exist, but must not block new projects. Do not merge
        # their contents or replace an already persisted folder identity.
        current = target
    elif not binding:
        aliases = {name.casefold()}
        if previous_name:
            aliases.add(normalized(previous_name))
        # Audit names also make retries after an unavailable Graph connection possible.
        for audit in db.scalars(select(AuditLog).where(
            AuditLog.entity_type == "person", AuditLog.entity_id == person_id,
            AuditLog.action == "person.updated",
        )):
            for snapshot in (audit.old_value_json, audit.new_value_json):
                if isinstance(snapshot, dict) and snapshot.get("display_name"):
                    aliases.add(normalized(snapshot["display_name"]))
        aliases -= other_names
        matches = [item for item in candidates if item["name"].casefold() in aliases]
        if len(matches) > 1:
            raise HTTPException(409, "Mehrere alte/neue Projektleiterordner gefunden. Keine automatische Zusammenführung.")
        current = matches[0] if matches else None

    if current:
        owner = db.scalar(select(ProjectManagerFolder).where(
            ProjectManagerFolder.drive_id == drive_id,
            ProjectManagerFolder.folder_id == current["id"],
            ProjectManagerFolder.person_id != person_id,
        ))
        if owner or (target and target["id"] != current["id"]):
            raise HTTPException(409, "Projektleiterordner-Konflikt. Bestehende Ordner bleiben unverändert.")
        if current.get("name") != name:
            old_url = current.get("webUrl")
            current = storage._move_or_rename_folder(
                item_id=current["id"], target_parent_item_id=parent_id, folder_name=name,
            )
            _refresh_descendant_links(db, old_url, current.get("webUrl"))
    elif create:
        current = storage._create_folder(parent_id, name)
    else:
        return None
    if not isinstance(current.get("id"), str) or not current["id"]:
        raise HTTPException(502, "Microsoft Graph lieferte keine Projektleiterordner-ID.")
    if not binding:
        db.add(ProjectManagerFolder(person_id=person_id, drive_id=drive_id,
                                    parent_folder_id=parent_id, folder_id=current["id"]))
        db.flush()
    return current


def _refresh_descendant_links(db, old_url, new_url):
    """Cached path URLs follow a renamed ancestor; item IDs remain untouched."""
    if not isinstance(old_url, str) or not isinstance(new_url, str) or not old_url or not new_url or old_url == new_url:
        return
    old_prefix, new_prefix = old_url.rstrip("/") + "/", new_url.rstrip("/") + "/"
    for model, column in (
        (Site, Site.project_folder_web_url),
        (ProjectFolder, ProjectFolder.external_web_url),
        (ExtraWorkTicketPhoto, ExtraWorkTicketPhoto.external_web_url),
        (SiteMeasurementBatchPhoto, SiteMeasurementBatchPhoto.external_web_url),
    ):
        db.execute(update(model).where(column.startswith(old_prefix, autoescape=True)).values({
            column: literal(new_prefix) + func.substr(column, len(old_prefix) + 1),
        }).execution_options(synchronize_session="fetch"))
