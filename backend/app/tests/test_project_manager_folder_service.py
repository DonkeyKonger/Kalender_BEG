from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, AuditLog, Person, ProjectFolder, ProjectManagerFolder, Site
from app.schemas.person import PersonUpdate
from app.schemas.site import SiteCreate, SiteUpdate
from app.services.person_service import PersonService
from app.services.project_manager_folder_service import sync_manager_rename
from app.services.project_storage_service import ProjectStorageService
from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.site_service import SiteService


class FolderGraph:
    def __init__(self):
        self.items = {}
        self.posts = []
        self.patches = []
        self.fail = False

    def folder(self, item_id, name, parent="root"):
        self.items[item_id] = {"id": item_id, "name": name, "folder": {}, "parentReference": {"id": parent}}
        return self.items[item_id]

    def get(self, path):
        if self.fail:
            raise MicrosoftGraphRequestError(503, "unavailable")
        item_id = path.split("/items/", 1)[1].split("/")[0].split("?")[0]
        if "/children?" in path:
            return {"value": [dict(item) for item in self.items.values() if item["parentReference"]["id"] == item_id]}
        if item_id not in self.items:
            raise MicrosoftGraphRequestError(404, "missing")
        return dict(self.items[item_id])

    def post(self, path, payload):
        self.posts.append((path, payload))
        return self.folder(f"created-{len(self.posts)}", payload["name"], path.split("/items/")[1].split("/")[0])

    def patch(self, path, payload):
        self.patches.append((path, payload))
        item_id = path.split("/items/")[1]
        self.items[item_id].update(payload)
        return dict(self.items[item_id])


@pytest.fixture
def env():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        person = Person(first_name="Christopher", last_name="Erichsen", display_name="CE", short_code="CE")
        db.add(person)
        db.flush()
        config = SimpleNamespace(ms_graph_enabled=True, ms_graph_create_project_folders_enabled=True,
            ms_project_drive_id="drive", ms_project_root_folder_id="root", ms_tenant_id="tenant",
            ms_client_id="client", ms_client_secret="unused", ms_graph_base_url="https://graph.microsoft.com/v1.0")
        graph = FolderGraph()
        storage = ProjectStorageService(graph_client=graph, config=config, db=db)
        yield db, person, graph, storage


def resolve(env, name="CE", parent="root", **kwargs):
    db, person, graph, storage = env
    person.display_name = name.replace("_", " ")
    return storage.resolve_project_manager_folder(person_id=person.id, parent_id=parent, name=name, **kwargs)


def test_binding_keeps_folder_and_children_when_manager_is_renamed(env):
    db, person, graph, storage = env
    graph.folder("ce", "CE")
    graph.folder("site", "8007_Klinik", "ce")
    assert resolve(env)["id"] == "ce"
    person.display_name = "Christopher Erichsen"
    assert resolve(env, "Christopher_Erichsen")["id"] == "ce"
    assert graph.items["site"]["parentReference"]["id"] == "ce"
    assert graph.posts == []
    assert len(graph.patches) == 1
    assert resolve(env, "Christopher_Erichsen")["id"] == "ce"
    assert len(graph.patches) == 1
    assert db.scalar(select(ProjectManagerFolder)).folder_id == "ce"


def test_first_creation_is_reused_for_more_sites(env):
    first = resolve(env)
    assert resolve(env)["id"] == first["id"]
    assert len(env[2].posts) == 1


def test_stale_caller_name_cannot_rename_folder_back(env):
    db, person, graph, storage = env
    graph.folder("ce", "CE")
    resolve(env)
    person.display_name = "Christopher Erichsen"
    db.flush()
    result = storage.resolve_project_manager_folder(person_id=person.id, parent_id="root", name="CE")
    assert result["name"] == "Christopher_Erichsen"
    assert graph.posts == []


def test_rename_refreshes_cached_descendant_links_but_not_similar_names(env, monkeypatch):
    db, person, graph, storage = env
    graph.folder("ce", "CE")["webUrl"] = "https://example.invalid/CE"
    site = Site(name="Klinik", project_manager_person_id=person.id,
                project_folder_web_url="https://example.invalid/CE/8007_Klinik")
    unrelated = Site(name="Other", project_folder_web_url="https://example.invalid/CE2/Other")
    db.add_all([site, unrelated])
    db.flush()
    folder = ProjectFolder(site_id=site.id, sort_order=1, name="Angebote", folder_key="angebote",
        external_item_id="documents", external_web_url="https://example.invalid/CE/8007_Klinik/01_Angebote")
    db.add(folder)
    resolve(env)
    original_patch = graph.patch
    def patch(path, payload):
        result = original_patch(path, payload)
        result["webUrl"] = "https://example.invalid/Christopher_Erichsen"
        return result
    monkeypatch.setattr(graph, "patch", patch)
    resolve(env, "Christopher_Erichsen")
    assert site.project_folder_web_url == "https://example.invalid/Christopher_Erichsen/8007_Klinik"
    assert folder.external_web_url == "https://example.invalid/Christopher_Erichsen/8007_Klinik/01_Angebote"
    assert folder.external_item_id == "documents"
    assert unrelated.project_folder_web_url == "https://example.invalid/CE2/Other"


def test_rename_hook_adopts_legacy_active_and_archive_folders(env, monkeypatch):
    db, person, graph, storage = env
    graph.folder("ce", "CE")
    graph.folder("archive", "Archiv")
    graph.folder("archived-ce", "CE", "archive")
    db.add(Site(name="Klinik", project_manager_person_id=person.id))
    db.flush()
    monkeypatch.setattr("app.services.project_manager_folder_service.ProjectStorageService", lambda **kwargs: storage)
    PersonService(db).update_person(person.id, PersonUpdate(display_name="Christopher Erichsen"), user_id=None)
    assert graph.items["ce"]["name"] == "Christopher_Erichsen"
    assert graph.items["archived-ce"]["name"] == "Christopher_Erichsen"
    assert len(db.scalars(select(ProjectManagerFolder)).all()) == 2
    assert graph.posts == []


def test_failed_rename_is_visible_and_retried_from_audit_history(env, monkeypatch):
    db, person, graph, storage = env
    graph.folder("ce", "CE")
    site = Site(name="Klinik", project_manager_person_id=person.id, project_folder_id="site")
    db.add(site)
    db.flush()
    graph.fail = True
    monkeypatch.setattr("app.services.project_manager_folder_service.ProjectStorageService", lambda **kwargs: storage)
    PersonService(db).update_person(person.id, PersonUpdate(display_name="Christopher Erichsen"), user_id=None)
    assert person.display_name == "Christopher Erichsen"
    assert site.project_folder_status == "error"
    assert site.project_folder_id == "site"
    graph.fail = False
    assert resolve(env, "Christopher_Erichsen")["id"] == "ce"
    assert graph.posts == []


@pytest.mark.parametrize("parent", ["root", "archive"])
def test_current_calendar_name_wins_over_unbound_historical_folders(env, parent):
    db, person, graph, storage = env
    graph.folder("old", "CE", parent)
    graph.folder("old-site", "8007_Klinik", "old")
    graph.folder("new", "Christopher_Erichsen", parent)
    person.display_name = "Christopher Erichsen"
    db.add(AuditLog(action="person.updated", entity_type="person", entity_id=person.id,
        old_value_json={"display_name": "CE"}, new_value_json={"display_name": person.display_name}))

    assert resolve(env, "Christopher_Erichsen", parent=parent)["id"] == "new"
    assert resolve(env, "Christopher_Erichsen", parent=parent)["id"] == "new"
    assert db.scalar(select(ProjectManagerFolder)).folder_id == "new"
    assert graph.items["old-site"]["parentReference"]["id"] == "old"
    assert graph.items["old"]["name"] == "CE"
    assert graph.posts == graph.patches == []

    # The chosen identity also survives the next rename; no third container.
    assert resolve(env, "Christopher_E", parent=parent)["id"] == "new"
    assert graph.items["old"]["name"] == "CE"
    assert graph.posts == []
    assert len(graph.patches) == 1


def test_multiple_historical_folders_without_current_name_remain_ambiguous(env):
    db, person, graph, storage = env
    graph.folder("old", "CE")
    graph.folder("old2", "CC")
    db.add(AuditLog(action="person.updated", entity_type="person", entity_id=person.id,
        old_value_json={"display_name": "CE"}, new_value_json={"display_name": "CC"}))
    with pytest.raises(HTTPException, match="Mehrere"):
        resolve(env, "Christopher_Erichsen")
    assert graph.posts == graph.patches == []


def test_create_site_with_legacy_manager_folders_and_retry_keeps_one_project(env, monkeypatch):
    db, person, graph, storage = env
    graph.folder("old", "CE")
    graph.folder("current", "Christopher_Erichsen")
    graph.folder("old-site", "8007_Klinik", "old")
    person.display_name = "Christopher Erichsen"
    db.add(AuditLog(action="person.updated", entity_type="person", entity_id=person.id,
        old_value_json={"display_name": "CE"}, new_value_json={"display_name": person.display_name}))
    monkeypatch.setattr(storage, "_ensure_material_order_template", lambda folder_id: None)
    service = SiteService(db, project_storage=storage)

    site = service.create_site(SiteCreate(
        name="Neubau", site_number="8038", project_manager_person_id=person.id, color="#60a5fa",
    ), user_id=None)

    assert site.project_folder_status == "created"
    folder_id = site.project_folder_id
    assert graph.items[folder_id]["parentReference"]["id"] == "current"
    assert len(db.scalars(select(ProjectFolder).where(
        ProjectFolder.site_id == site.id, ProjectFolder.external_item_id.is_not(None),
    )).all()) == 15
    post_count = len(graph.posts)
    service.update_site(site.id, SiteUpdate(name="Neubau"), user_id=None)
    assert site.project_folder_id == folder_id
    assert len(graph.posts) == post_count
    assert graph.items["old-site"]["parentReference"]["id"] == "old"
    assert graph.patches == []


def test_new_sites_after_repeated_manager_renames_reuse_the_same_container(env, monkeypatch):
    db, person, graph, storage = env
    monkeypatch.setattr(storage, "_ensure_material_order_template", lambda folder_id: None)
    monkeypatch.setattr("app.services.project_manager_folder_service.ProjectStorageService", lambda **kwargs: storage)
    service = SiteService(db, project_storage=storage)
    first = service.create_site(SiteCreate(
        name="Erste Baustelle", site_number="8038", project_manager_person_id=person.id, color="#60a5fa",
    ), user_id=None)
    manager_id = graph.items[first.project_folder_id]["parentReference"]["id"]
    for name in ("Christopher Erichsen", "C. Erichsen", "CE"):
        PersonService(db).update_person(person.id, PersonUpdate(display_name=name), user_id=None)
    second = service.create_site(SiteCreate(
        name="Zweite Baustelle", site_number="8039", project_manager_person_id=person.id, color="#60a5fa",
    ), user_id=None)

    assert graph.items[first.project_folder_id]["parentReference"]["id"] == manager_id
    assert graph.items[second.project_folder_id]["parentReference"]["id"] == manager_id
    assert graph.items[manager_id]["name"] == "CE"
    assert sum(path == "/drives/drive/items/root/children" for path, _ in graph.posts) == 1
    assert len(graph.patches) == 3


def test_previously_failed_site_can_retry_using_current_manager_name(env, monkeypatch):
    db, person, graph, storage = env
    graph.folder("old", "CE")
    graph.folder("current", "Christopher_Erichsen")
    person.display_name = "Christopher Erichsen"
    db.add(AuditLog(action="person.updated", entity_type="person", entity_id=person.id,
        old_value_json={"display_name": "CE"}, new_value_json={"display_name": person.display_name}))
    site = Site(name="Neubau", site_number="8038", project_manager_person_id=person.id,
                project_folder_status="error", project_folder_error="Mehrere alte/neue Projektleiterordner gefunden.")
    db.add(site)
    db.flush()
    monkeypatch.setattr(storage, "_ensure_material_order_template", lambda folder_id: None)

    SiteService(db, project_storage=storage).update_site(site.id, SiteUpdate(name=site.name), user_id=None)

    assert site.project_folder_status == "created"
    assert site.project_folder_error is None
    assert graph.items[site.project_folder_id]["parentReference"]["id"] == "current"
    assert not any(path == "/drives/drive/items/root/children" for path, _ in graph.posts)


def test_bound_folder_with_conflicting_destination_is_not_renamed(env):
    db, person, graph, storage = env
    graph.folder("ce", "CE")
    resolve(env)
    graph.folder("duplicate", "Christopher_Erichsen")
    with pytest.raises(HTTPException, match="Konflikt"):
        resolve(env, "Christopher_Erichsen")
    assert graph.patches == []


@pytest.mark.parametrize("change", ["missing", "moved", "file"])
def test_missing_or_externally_changed_binding_never_creates_replacement(env, change):
    graph = env[2]
    graph.folder("ce", "CE")
    resolve(env)
    if change == "missing":
        del graph.items["ce"]
    elif change == "moved":
        graph.items["ce"]["parentReference"] = {"id": "elsewhere"}
    else:
        del graph.items["ce"]["folder"]
    with pytest.raises(HTTPException):
        resolve(env, "New_Name")
    assert graph.posts == graph.patches == []


def test_duplicate_person_names_cannot_share_folder(env):
    db, person, graph, storage = env
    db.add(Person(first_name="Other", last_name="Person", display_name="CE", short_code="OP"))
    graph.folder("ce", "CE")
    with pytest.raises(HTTPException, match="nicht eindeutig"):
        resolve(env)
    assert graph.posts == graph.patches == []


@pytest.mark.parametrize("with_legacy", [False, True])
def test_other_person_binding_cannot_be_adopted(env, with_legacy):
    db, person, graph, storage = env
    other = Person(first_name="Other", last_name="Person", display_name="Other", short_code="OP")
    db.add(other)
    db.flush()
    graph.folder("ce", "CE")
    if with_legacy:
        graph.folder("legacy", "CC")
        db.add(AuditLog(action="person.updated", entity_type="person", entity_id=person.id,
            old_value_json={"display_name": "CC"}, new_value_json={"display_name": "CE"}))
    db.add(ProjectManagerFolder(person_id=other.id, drive_id="drive", parent_folder_id="root", folder_id="ce"))
    with pytest.raises(HTTPException, match="Konflikt"):
        resolve(env)
    assert graph.posts == graph.patches == []


def test_normal_employee_rename_and_disabled_graph_do_not_touch_cloud(env):
    db, person, graph, storage = env
    assert sync_manager_rename(db, person, "Old", storage=storage) == []
    db.add(Site(name="Klinik", project_manager_person_id=person.id))
    storage.config.ms_graph_enabled = False
    graph.fail = True
    assert sync_manager_rename(db, person, "Old", storage=storage) == []
    assert graph.posts == graph.patches == []


def test_project_folder_is_moved_by_id_without_replacing_its_contents(env):
    graph, storage = env[2:]
    graph.folder("site", "8007_Klinik")
    graph.folder("document-folder", "01_Angebote", "site")
    result = storage._resolve_site_folder(target_parent_item_id="ce", folder_name="8007_Klinik", existing_folder_id="site")
    assert result["id"] == "site"
    assert graph.items["document-folder"]["parentReference"]["id"] == "site"
    assert graph.posts == []


@pytest.mark.parametrize("existing", [None, "site"])
def test_duplicate_project_folder_is_reported_without_move(env, existing):
    graph, storage = env[2:]
    graph.folder("site", "8007_Klinik")
    graph.folder("duplicate", "8007_Klinik", "ce")
    with pytest.raises(HTTPException):
        storage._resolve_site_folder(target_parent_item_id="ce", folder_name="8007_Klinik", existing_folder_id=existing)
    assert graph.posts == graph.patches == []


def test_missing_linked_project_does_not_create_empty_duplicate(env):
    with pytest.raises(HTTPException, match="fehlt"):
        env[3]._resolve_site_folder(target_parent_item_id="ce", folder_name="8007_Klinik", existing_folder_id="missing")
    assert env[2].posts == []


def test_folder_search_reads_next_page_before_creating(env, monkeypatch):
    storage = env[3]
    collection = "/drives/drive/items/root/children"
    calls = []
    def get(path):
        calls.append(path)
        if "skiptoken" in path:
            return {"value": [{"id": "ce", "name": "CE", "folder": {}}]}
        return {"value": [], "@odata.nextLink": "https://graph.microsoft.com/v1.0" + collection + "?$skiptoken=next"}
    monkeypatch.setattr(env[2], "get", get)
    assert storage._ensure_folder("root", "CE")["id"] == "ce"
    assert len(calls) == 2
    assert env[2].posts == []


@pytest.mark.parametrize("next_link", ["https://example.invalid/steal", "https://graph.microsoft.com/v1.0/drives/other/items/root/children?$skiptoken=next"])
def test_folder_search_rejects_foreign_pagination(env, monkeypatch, next_link):
    monkeypatch.setattr(env[2], "get", lambda path: {"value": [], "@odata.nextLink": next_link})
    with pytest.raises(HTTPException, match="Folgeseite"):
        env[3]._ensure_folder("root", "CE")
    assert env[2].posts == []
