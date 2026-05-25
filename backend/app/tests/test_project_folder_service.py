import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus, UserRole
from app.models.project_folder import ProjectFolder
from app.models.site import Site
from app.models.user import User
from app.services.project_folder_service import ProjectFolderService


def db_session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def create_site(db: Session) -> Site:
    site = Site(name="Testbaustelle", status=SiteStatus.ACTIVE, location_status=SiteLocationStatus.UNCHECKED)
    db.add(site)
    db.flush()
    return site


def user(role: UserRole) -> User:
    return User(username=f"{role.value}-user", display_name="Test", password_hash="x", role=role, is_active=True)


def test_default_project_folders_are_created_once():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)

    first = service.create_default_project_folders_for_site(site.id)
    second = service.create_default_project_folders_for_site(site.id)
    stored_count = len(db.scalars(select(ProjectFolder).where(ProjectFolder.site_id == site.id)).all())

    assert len(first) == 15
    assert len(second) == 15
    assert stored_count == 15


def test_project_folder_visibility_by_role():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)
    service.create_default_project_folders_for_site(site.id)

    admin_folders = service.get_visible_project_folders_for_site(site.id, user(UserRole.ADMIN))
    monteur_folders = service.get_visible_project_folders_for_site(site.id, user(UserRole.MONTEUR))

    assert len(admin_folders) == 15
    assert [folder.folder_key for folder in monteur_folders] == [
        "terminplan",
        "aufmass",
        "dokumentation",
        "zeichnungen",
        "fotos",
    ]


def test_direct_folder_access_blocks_disallowed_role():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)
    service.create_default_project_folders_for_site(site.id)
    folder = db.scalar(select(ProjectFolder).where(ProjectFolder.folder_key == "angebote"))
    assert folder is not None

    with pytest.raises(HTTPException) as error:
        service.get_project_folder(folder.id, user(UserRole.MONTEUR))

    assert error.value.status_code == 403
