from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.dependencies import get_current_app_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.audit_log import AuditLog
from app.models.enums import UserRole
from app.services.project_folder_service import ProjectFolderService, role_can_access_project_folder
from app.tests.test_project_folder_service import create_site, db_session, user


def test_grant_is_persistent_site_scoped_and_controls_direct_access():
    with db_session() as db:
        first, second = create_site(db), create_site(db)
        service = ProjectFolderService(db)
        admin, monteur = user(UserRole.ADMIN), user(UserRole.MONTEUR)
        folder = service.update_monteur_visibility(first.id, "angebote", True, admin)
        folder_id = folder.id
        db.expire_all()
        service.create_default_project_folders_for_site(first.id)
        assert service.get_project_folder(folder_id, monteur).monteur_visibility_override is True
        assert service.get_project_folder_for_site_by_key(first.id, "angebote", monteur).id == folder_id
        assert "angebote" in {f.folder_key for f in service.get_visible_project_folders_for_site(first.id, monteur)}
        assert "angebote" not in {f.folder_key for f in service.get_visible_project_folders_for_site(second.id, monteur)}
        with pytest.raises(HTTPException) as denied:
            service.get_project_folder_for_site_by_key(second.id, "angebote", monteur)
        assert denied.value.status_code == 403
        audit = db.scalar(select(AuditLog))
        assert audit.entity_id == folder_id
        assert audit.old_value_json == {"visible_for_monteurs": False}
        assert audit.new_value_json == {"visible_for_monteurs": True, "site_id": first.id}


@pytest.mark.parametrize("key", ["angebote", "fotos", "terminplan"])
def test_revoke_blocks_listing_and_direct_access_but_not_office(key):
    with db_session() as db:
        site = create_site(db)
        service = ProjectFolderService(db)
        admin, monteur = user(UserRole.ADMIN), user(UserRole.MONTEUR)
        service.update_monteur_visibility(site.id, key, True, admin)
        folder = service.update_monteur_visibility(site.id, key, False, admin)
        assert key not in {f.folder_key for f in service.get_visible_project_folders_for_site(site.id, monteur)}
        for resolve in [lambda: service.get_project_folder(folder.id, monteur),
                        lambda: service.get_project_folder_for_site_by_key(site.id, key, monteur)]:
            with pytest.raises(HTTPException) as denied:
                resolve()
            assert denied.value.status_code == 403
        assert service.get_project_folder(folder.id, admin).id == folder.id
        folder.is_active = False
        folder.monteur_visibility_override = True
        assert not role_can_access_project_folder(UserRole.MONTEUR, folder)


def test_invalid_targets_and_monteur_cannot_change_access():
    with db_session() as db:
        site = create_site(db)
        service = ProjectFolderService(db)
        for site_id, key, actor, expected in [
            (site.id, "angebote", UserRole.MONTEUR, 403),
            (site.id, "missing", UserRole.ADMIN, 404),
            (9999, "angebote", UserRole.ADMIN, 404),
        ]:
            with pytest.raises(HTTPException) as error:
                service.update_monteur_visibility(site_id, key, True, user(actor))
            assert error.value.status_code == expected
        assert list(db.scalars(select(AuditLog))) == []


def test_download_route_enforces_grant_and_revocation_before_storage(monkeypatch):
    downloads = []
    class Storage:
        def download_file_from_folder(self, **kwargs):
            downloads.append(kwargs)
            return {"filename": "test.pdf", "content": b"test", "content_type": "application/pdf"}
    monkeypatch.setattr(sites, "ProjectStorageService", Storage)
    with db_session() as db:
        site = create_site(db)
        service = ProjectFolderService(db)
        admin, monteur = user(UserRole.ADMIN), user(UserRole.MONTEUR)
        service.update_monteur_visibility(site.id, "angebote", True, admin)
        response = sites.download_project_folder_document(site.id, "angebote", "test-file", monteur, db)
        assert response.body == b"test"
        service.update_monteur_visibility(site.id, "angebote", False, admin)
        with pytest.raises(HTTPException) as denied:
            sites.download_project_folder_document(site.id, "angebote", "test-file", monteur, db)
        assert denied.value.status_code == 403
        assert len(downloads) == 1


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["sites"], 200), (UserRole.OFFICE, ["calendar"], 403),
    (UserRole.MONTEUR, [], 403),
])
def test_visibility_route_requires_site_edit_permission(monkeypatch, role, permissions, expected):
    calls = []
    class Folders:
        def __init__(self, db): pass
        def update_monteur_visibility(self, site_id, key, visible, actor):
            calls.append((site_id, key, visible))
            return SimpleNamespace(id=10, site_id=site_id, folder_key=key, name="Angebote",
                sort_order=1, is_active=True, monteur_visibility_override=visible,
                created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(role=role, office_page_permissions=permissions)
    client = TestClient(app)
    response = client.patch("/sites/7/project-folders/angebote/visibility", json={"visible_for_monteurs": True})
    assert response.status_code == expected
    assert calls == ([(7, "angebote", True)] if expected == 200 else [])
    if expected == 200:
        assert response.json()["visible_for_monteurs"] is True
        for payload in [{}, {"visible_for_monteurs": None}, {"visible_for_monteurs": "false"}]:
            assert client.patch("/sites/7/project-folders/angebote/visibility", json=payload).status_code == 422
        assert len(calls) == 1
