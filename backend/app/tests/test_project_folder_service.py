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
from app.schemas.photo import PhotoCaptionUpdate


def db_session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def create_site(db: Session) -> Site:
    site = Site(
        name="Testbaustelle", status=SiteStatus.ACTIVE, location_status=SiteLocationStatus.UNCHECKED
    )
    db.add(site)
    db.flush()
    return site


def user(role: UserRole) -> User:
    return User(
        username=f"{role.value}-user",
        display_name="Test",
        password_hash="x",
        role=role,
        is_active=True,
    )


def test_default_project_folders_are_created_once():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)

    first = service.create_default_project_folders_for_site(site.id)
    second = service.create_default_project_folders_for_site(site.id)
    stored_count = len(
        db.scalars(select(ProjectFolder).where(ProjectFolder.site_id == site.id)).all()
    )

    assert len(first) == 15
    assert len(second) == 15
    assert stored_count == 15


def test_default_project_folders_normalize_legacy_auftraege_name():
    db = db_session()
    site = create_site(db)
    legacy_folder = ProjectFolder(
        site_id=site.id,
        sort_order=3,
        name="Auftraege",
        folder_key="auftraege",
        is_active=True,
    )
    db.add(legacy_folder)
    db.flush()

    folders = ProjectFolderService(db).create_default_project_folders_for_site(site.id)

    auftraege = next(folder for folder in folders if folder.folder_key == "auftraege")
    assert auftraege.name == "Aufträge"
    assert legacy_folder.name == "Aufträge"


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


def test_attach_external_subfolders_updates_matching_logical_folders():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)
    service.create_default_project_folders_for_site(site.id)

    service.attach_external_subfolders_for_site(
        site.id,
        [
            {
                "sort_order": 1,
                "id": "sp-folder-1",
                "web_url": "https://example.invalid/01_Angebote",
            },
            {
                "sort_order": 5,
                "id": "sp-folder-5",
                "web_url": "https://example.invalid/05_Terminplan",
            },
        ],
        drive_id="drive-1",
    )

    angebote = db.scalar(
        select(ProjectFolder).where(ProjectFolder.site_id == site.id, ProjectFolder.sort_order == 1)
    )
    terminplan = db.scalar(
        select(ProjectFolder).where(ProjectFolder.site_id == site.id, ProjectFolder.sort_order == 5)
    )
    assert angebote is not None
    assert terminplan is not None
    assert angebote.external_provider == "sharepoint"
    assert angebote.external_drive_id == "drive-1"
    assert angebote.external_item_id == "sp-folder-1"
    assert angebote.external_web_url == "https://example.invalid/01_Angebote"
    assert terminplan.external_web_url == "https://example.invalid/05_Terminplan"


def test_project_document_captions_are_persisted_attached_and_removable():
    db = db_session()
    site = create_site(db)
    service = ProjectFolderService(db)

    saved = service.update_document_caption(
        site_id=site.id,
        folder_key="fotos",
        item_id="sharepoint-photo-1",
        caption="Montierte Kabelrinne",
    )
    items = service.add_document_captions(
        site_id=site.id,
        folder_key="fotos",
        items=[
            {"id": "sharepoint-photo-1", "name": "foto-1.jpg"},
            {"id": "sharepoint-photo-2", "name": "foto-2.jpg"},
        ],
    )

    assert saved == "Montierte Kabelrinne"
    assert [item["caption"] for item in items] == ["Montierte Kabelrinne", None]

    service.update_document_caption(
        site_id=site.id,
        folder_key="fotos",
        item_id="sharepoint-photo-1",
        caption=None,
    )
    cleared = service.add_document_captions(
        site_id=site.id,
        folder_key="fotos",
        items=[{"id": "sharepoint-photo-1", "name": "foto-1.jpg"}],
    )
    assert cleared[0]["caption"] is None


def test_photo_caption_payload_trims_text_and_keeps_empty_caption_optional():
    assert PhotoCaptionUpdate(caption="  Zwei Zeilen\nDokumentation  ").caption == "Zwei Zeilen\nDokumentation"
    assert PhotoCaptionUpdate(caption="   ").caption is None
