from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus, UserRole
from app.models.project_folder import ProjectFolder, ProjectFolderDocumentCaption
from app.models.site import Site
from app.models.user import User
from app.services.project_photo_pdf_service import ProjectPhotoPdfService


def _db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def _image_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (1200, 700), (184, 194, 206)).save(output, format="JPEG")
    return output.getvalue()


def _setup_project(db: Session) -> tuple[Site, User, ProjectFolder]:
    site = Site(
        site_number="9999",
        name="Testbaustelle Finienweg",
        street="Finienweg",
        house_number="10",
        postal_code="28832",
        city="Achim",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    user = User(
        username="monteur",
        display_name="Christopher Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
    )
    db.add_all([site, user])
    db.flush()
    folder = ProjectFolder(
        site_id=site.id,
        sort_order=14,
        name="Fotos",
        folder_key="fotos",
        is_active=True,
        external_drive_id="drive-1",
        external_item_id="folder-1",
    )
    db.add(folder)
    db.commit()
    return site, user, folder


def test_project_photo_pdf_uses_project_context_captions_and_only_images():
    db = _db_session()
    site, user, _folder = _setup_project(db)
    db.add(
        ProjectFolderDocumentCaption(
            site_id=site.id,
            folder_key="fotos",
            external_item_id="photo-1",
            caption="Technikraum nach Abschluss dokumentiert",
        )
    )
    db.commit()

    class FakeStorage:
        def list_folder_children(self, **_kwargs):
            return [
                {
                    "id": "photo-1",
                    "name": "projektfoto.jpg",
                    "created_date_time": "2026-08-21T10:35:00Z",
                    "mime_type": "image/jpeg",
                    "file_extension": "jpg",
                    "is_folder": False,
                },
                {
                    "id": "document-1",
                    "name": "plan.pdf",
                    "created_date_time": "2026-08-21T10:36:00Z",
                    "mime_type": "application/pdf",
                    "file_extension": "pdf",
                    "is_folder": False,
                },
            ]

        def download_file_from_folder(self, **kwargs):
            assert kwargs["item_id"] == "photo-1"
            return {"content": _image_bytes()}

    content, filename = ProjectPhotoPdfService(db, storage=FakeStorage()).build_site_photo_appendix(
        site_id=site.id,
        current_user=user,
    )
    reader = PdfReader(BytesIO(content))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    assert filename == "Fotoanlage_Projektfotos_9999.pdf"
    assert len(reader.pages) == 1
    assert "Fotoanlage" in text
    assert "Projektfotos" in text
    assert "Technikraum nach Abschluss dokumentiert" in text
    assert "projektfoto.jpg" in text
    assert "plan.pdf" not in text
    assert "Zusatzauftrag Nr." not in text
    assert "Aufmaß Nr." not in text


def test_project_photo_pdf_returns_not_found_without_images():
    db = _db_session()
    site, user, _folder = _setup_project(db)

    class EmptyStorage:
        def list_folder_children(self, **_kwargs):
            return []

    with pytest.raises(HTTPException) as error:
        ProjectPhotoPdfService(db, storage=EmptyStorage()).build_site_photo_appendix(
            site_id=site.id,
            current_user=user,
        )

    assert error.value.status_code == 404
