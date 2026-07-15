import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page, require_office_page, require_roles
from app.core.database import get_db
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketCreate, ExtraWorkTicketRead
from app.schemas.measurement import (
    MeasurementBaseRead,
    MeasurementBaseUpdate,
    MeasurementEntryCreate,
    MeasurementEntryRead,
    MeasurementImportResponse,
    MeasurementItemRead,
    MeasurementItemUpdate,
    MeasurementTimeAnalysisRead,
    MeasurementTimesheetRead,
    MobileMeasurementBatchRead,
    MobileMeasurementFreeItemCreate,
    MobileMeasurementItemRead,
)
from app.schemas.person import PersonRead
from app.schemas.project_folder import (
    ProjectFolderDocumentItem,
    ProjectFolderDocumentList,
    ProjectFolderRead,
)
from app.schemas.site import (
    SiteCreate,
    SiteGeocodeSearchResult,
    SiteMapResponse,
    SiteRead,
    SiteRemovePlan,
    SiteSummary,
    SiteRemoveResponse,
    SiteUpdate,
)
from app.services.document_thumbnail_service import (
    DocumentThumbnailService,
    PdfThumbnailUnavailableError,
    THUMBNAIL_MEDIA_TYPE,
    is_pdf_document,
)
from app.services.extra_work_service import ExtraWorkService
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.geo_service import search_geocoding_candidates
from app.services.measurement_pdf_service import MeasurementPdfService
from app.services.measurement_service import MeasurementService
from app.services.photo_filename import (
    PHOTO_UPLOAD_FOLDER_KEY,
    build_photo_filename,
    is_supported_photo_upload,
    photo_extension_from_upload,
    user_photo_name,
)
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService
from app.services.site_service import SiteService

router = APIRouter(prefix="/sites", tags=["sites"])
logger = logging.getLogger(__name__)

CAN_READ = require_business_page(
    "sites",
    "calendar",
    "map",
    "customers",
    "payroll",
)
CAN_FOLDER_READ = require_office_page(
    "sites",
    roles=(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR),
)
CAN_WRITE = require_business_page("sites", "calendar")
CAN_ADMIN = require_roles(UserRole.ADMIN)

SAFE_INLINE_CONTENT_TYPES = {
    "application/pdf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
}
TIMESHEET_DOCUMENTATION_FOLDER_KEY = "dokumentation"


@router.get("", response_model=list[SiteRead])
def list_sites(
    include_closed: bool = False,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[SiteRead]:
    sites = SiteService(db).list_sites(include_closed=include_closed)
    return [SiteRead.model_validate(site) for site in sites]


@router.get("/summary", response_model=list[SiteSummary])
def list_site_summaries(
    include_closed: bool = False,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[SiteSummary]:
    sites = SiteService(db).list_site_summaries(include_closed=include_closed)
    return [SiteSummary.model_validate(site) for site in sites]


@router.get("/project-managers", response_model=list[PersonRead])
def list_project_manager_people(
    _user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> list[PersonRead]:
    statement = (
        select(Person)
        .join(User, User.person_id == Person.id)
        .where(
            User.is_active.is_(True),
            User.role.in_([UserRole.ADMIN, UserRole.PROJECT_MANAGER]),
            Person.is_active.is_(True),
            Person.deleted_at.is_(None),
            Person.person_type == PersonType.INTERNAL,
        )
        .distinct()
        .order_by(Person.display_name, Person.id)
    )
    return [PersonRead.model_validate(person) for person in db.scalars(statement)]


@router.get("/map", response_model=SiteMapResponse)
def site_map(
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> SiteMapResponse:
    return SiteService(db).site_map()


@router.get("/geocode/search", response_model=list[SiteGeocodeSearchResult])
def search_site_geocode(
    q: str = Query(..., min_length=3, max_length=200),
    limit: int = Query(default=5, ge=1, le=5),
    _user=Depends(CAN_READ),
) -> list[SiteGeocodeSearchResult]:
    return [
        SiteGeocodeSearchResult(
            label=candidate.label,
            postal_code=candidate.postal_code,
            city=candidate.city,
            street=candidate.street,
            house_number=candidate.house_number,
            latitude=candidate.latitude,
            longitude=candidate.longitude,
            confidence=candidate.confidence,
            source=candidate.source,
        )
        for candidate in search_geocoding_candidates(q, limit=limit)
    ]


@router.get("/{site_id}", response_model=SiteRead)
def get_site(
    site_id: int,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).get_site(site_id)
    return SiteRead.model_validate(site)


@router.get("/{site_id}/project-folders", response_model=list[ProjectFolderRead])
def list_project_folders(
    site_id: int,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> list[ProjectFolderRead]:
    folders = ProjectFolderService(db).get_visible_project_folders_for_site(site_id, current_user)
    return [ProjectFolderRead.model_validate(folder) for folder in folders]


@router.get(
    "/{site_id}/documents/folders/{folder_key}/children",
    response_model=ProjectFolderDocumentList,
)
def list_project_folder_documents(
    site_id: int,
    folder_key: str,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> ProjectFolderDocumentList:
    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    items = ProjectStorageService().list_folder_children(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
    )
    return ProjectFolderDocumentList(
        folder_key=folder.folder_key,
        folder_name=folder.name,
        items=items,
    )


@router.get(
    "/{site_id}/documents/folders/{folder_key}/items/{item_id}/children",
    response_model=ProjectFolderDocumentList,
)
def list_project_folder_item_children(
    site_id: int,
    folder_key: str,
    item_id: str,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> ProjectFolderDocumentList:
    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    items = ProjectStorageService().list_folder_item_children(
        drive_id=folder.external_drive_id,
        root_folder_item_id=folder.external_item_id,
        item_id=item_id,
    )
    return ProjectFolderDocumentList(
        folder_key=folder.folder_key,
        folder_name=folder.name,
        items=items,
    )


@router.get("/{site_id}/documents/folders/{folder_key}/items/{item_id}/download")
def download_project_folder_document(
    site_id: int,
    folder_key: str,
    item_id: str,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> Response:
    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    download = ProjectStorageService().download_file_from_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        item_id=item_id,
    )
    filename = str(download["filename"])
    return Response(
        content=download["content"],
        media_type=str(download["content_type"]),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/{site_id}/documents/folders/{folder_key}/items/{item_id}/content")
def get_project_folder_document_content(
    site_id: int,
    folder_key: str,
    item_id: str,
    disposition: str = Query(default="inline"),
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> Response:
    if disposition not in {"inline", "attachment"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Content-Disposition.")

    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    download = ProjectStorageService().download_file_from_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        item_id=item_id,
    )
    filename = str(download["filename"])
    content_type = str(download["content_type"] or "application/octet-stream")
    normalized_content_type = content_type.split(";", 1)[0].strip().lower()
    effective_disposition = disposition
    media_type = content_type

    if disposition == "inline" and normalized_content_type not in SAFE_INLINE_CONTENT_TYPES:
        effective_disposition = "attachment"
        media_type = "application/octet-stream"

    return Response(
        content=download["content"],
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f"{effective_disposition}; filename*=UTF-8''{quote(filename, safe='')}"
            )
        },
    )


@router.get("/{site_id}/documents/folders/{folder_key}/items/{item_id}/thumbnail")
def get_project_folder_document_thumbnail(
    site_id: int,
    folder_key: str,
    item_id: str,
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> FileResponse:
    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    storage = ProjectStorageService()
    document = storage.get_file_item_from_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        item_id=item_id,
    )
    if not is_pdf_document(document):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine PDF-Vorschau verfügbar.")

    thumbnail_service = DocumentThumbnailService()
    cache_key = thumbnail_service.build_cache_key(
        site_id=site_id,
        folder_key=folder.folder_key,
        drive_id=folder.external_drive_id,
        item_id=item_id,
        document=document,
    )
    cached_thumbnail = thumbnail_service.get_cached_thumbnail(cache_key)
    if cached_thumbnail:
        return _thumbnail_response(cached_thumbnail)

    download = storage.download_file_from_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        item_id=item_id,
    )
    try:
        thumbnail_path = thumbnail_service.get_or_create_pdf_thumbnail(
            bytes(download["content"]),
            cache_key,
        )
    except PdfThumbnailUnavailableError as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF-Vorschau konnte nicht erzeugt werden.") from error
    return _thumbnail_response(thumbnail_path)


def _thumbnail_response(path: Path) -> FileResponse:
    return FileResponse(
        path,
        media_type=THUMBNAIL_MEDIA_TYPE,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post(
    "/{site_id}/documents/folders/{folder_key}/upload",
    response_model=ProjectFolderDocumentItem,
)
async def upload_project_folder_document(
    site_id: int,
    folder_key: str,
    file: UploadFile = File(...),
    current_user: User = Depends(CAN_FOLDER_READ),
    db: Session = Depends(get_db),
) -> ProjectFolderDocumentItem:
    folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id, folder_key, current_user
    )
    content = await file.read()
    storage = ProjectStorageService()
    filename = file.filename
    if folder_key == PHOTO_UPLOAD_FOLDER_KEY and is_supported_photo_upload(
        filename=file.filename,
        content_type=file.content_type,
    ):
        site = SiteService(db).get_site(site_id)
        existing_names = {
            str(item.get("name"))
            for item in storage.list_folder_children(
                drive_id=folder.external_drive_id,
                folder_item_id=folder.external_item_id,
            )
            if item.get("name")
        }
        filename = build_photo_filename(
            site_name=site.name,
            document_label=None,
            creator_name=user_photo_name(current_user),
            extension=photo_extension_from_upload(
                filename=file.filename,
                content_type=file.content_type,
            ),
            existing_names=existing_names,
        )
    uploaded = storage.upload_file_to_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        filename=filename,
        content=content,
        content_type=file.content_type,
    )
    return ProjectFolderDocumentItem.model_validate(uploaded)




@router.get("/{site_id}/measurement-bases", response_model=list[MeasurementBaseRead])
def list_measurement_bases(
    site_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[MeasurementBaseRead]:
    return MeasurementService(db).list_measurement_bases(site_id)


@router.patch("/{site_id}/measurement-bases/{measurement_base_id}", response_model=MeasurementBaseRead)
def update_measurement_base(
    site_id: int,
    measurement_base_id: int,
    payload: MeasurementBaseUpdate,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MeasurementBaseRead:
    return MeasurementService(db).update_measurement_base(
        site_id=site_id,
        measurement_base_id=measurement_base_id,
        payload=payload,
    )


@router.post("/{site_id}/measurement-bases/{measurement_base_id}/activate", response_model=list[MeasurementBaseRead])
def activate_measurement_base(
    site_id: int,
    measurement_base_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> list[MeasurementBaseRead]:
    return MeasurementService(db).activate_measurement_base(
        site_id=site_id,
        measurement_base_id=measurement_base_id,
    )


@router.delete("/{site_id}/measurement-bases/{measurement_base_id}", response_model=list[MeasurementBaseRead])
def delete_measurement_base(
    site_id: int,
    measurement_base_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> list[MeasurementBaseRead]:
    return MeasurementService(db).delete_measurement_base(
        site_id=site_id,
        measurement_base_id=measurement_base_id,
    )


@router.get("/{site_id}/extra-work-tickets", response_model=list[ExtraWorkTicketRead])
def list_extra_work_tickets(
    site_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[ExtraWorkTicketRead]:
    return ExtraWorkService(db).list_site_tickets(site_id)


@router.post("/{site_id}/extra-work-tickets", response_model=ExtraWorkTicketRead, status_code=status.HTTP_201_CREATED)
def create_extra_work_ticket(
    site_id: int,
    payload: ExtraWorkTicketCreate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> ExtraWorkTicketRead:
    return ExtraWorkService(db).create_site_ticket(
        site_id=site_id,
        current_user=current_user,
        payload=payload,
    )


@router.delete("/{site_id}/extra-work-tickets/{ticket_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_extra_work_ticket(
    site_id: int,
    ticket_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> None:
    ExtraWorkService(db).delete_site_ticket(
        site_id=site_id,
        ticket_id=ticket_id,
        current_user=current_user,
    )


@router.get("/{site_id}/extra-work-tickets/{ticket_id}/pdf")
def download_extra_work_ticket_pdf(
    site_id: int,
    ticket_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> Response:
    content, filename = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site_id,
        ticket_id=ticket_id,
    )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.get("/{site_id}/measurement-items", response_model=list[MeasurementItemRead])
def list_measurement_items(
    site_id: int,
    measurement_base_id: int | None = Query(default=None),
    active_only: bool = Query(default=False),
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[MeasurementItemRead]:
    items = MeasurementService(db).list_items(
        site_id,
        measurement_base_id=measurement_base_id,
        active_only=active_only,
    )
    return [MeasurementItemRead.model_validate(item) for item in items]


@router.get("/{site_id}/measurement-timesheet", response_model=MeasurementTimesheetRead)
def get_measurement_timesheet(
    site_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> MeasurementTimesheetRead:
    return MeasurementService(db).get_site_measurement_timesheet(site_id)


@router.post("/{site_id}/measurement-items/{measurement_item_id}/hide", response_model=MeasurementItemRead)
def hide_measurement_item(
    site_id: int,
    measurement_item_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MeasurementItemRead:
    return MeasurementService(db).hide_item(site_id=site_id, measurement_item_id=measurement_item_id)


@router.get("/{site_id}/measurement-time-analysis", response_model=MeasurementTimeAnalysisRead)
def get_measurement_time_analysis(
    site_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> MeasurementTimeAnalysisRead:
    return MeasurementService(db).get_site_measurement_time_analysis(site_id)


@router.get("/{site_id}/measurement-batches", response_model=list[MobileMeasurementBatchRead])
def list_measurement_batches(
    site_id: int,
    measurement_base_id: int | None = Query(default=None),
    active_only: bool = Query(default=False),
    archived_only: bool = Query(default=False),
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementBatchRead]:
    return MeasurementService(db).list_site_batches(
        site_id,
        measurement_base_id=measurement_base_id,
        active_only=active_only,
        archived_only=archived_only,
    )


@router.get(
    "/{site_id}/measurement-batches/{batch_id}/items",
    response_model=list[MobileMeasurementItemRead],
)
def list_measurement_batch_items(
    site_id: int,
    batch_id: int,
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementItemRead]:
    return MeasurementService(db).list_site_batch_items(site_id=site_id, batch_id=batch_id)


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/items",
    response_model=MobileMeasurementItemRead,
)
def create_measurement_batch_free_item(
    site_id: int,
    batch_id: int,
    payload: MobileMeasurementFreeItemCreate,
    user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementItemRead:
    return MeasurementService(db).create_site_free_item(
        site_id=site_id,
        batch_id=batch_id,
        current_user=user,
        payload=payload,
    )


@router.patch(
    "/{site_id}/measurement-batches/{batch_id}/items/{measurement_item_id}",
    response_model=MobileMeasurementItemRead,
)
def update_measurement_batch_free_item(
    site_id: int,
    batch_id: int,
    measurement_item_id: int,
    payload: MeasurementItemUpdate,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementItemRead:
    return MeasurementService(db).update_site_free_item(
        site_id=site_id,
        batch_id=batch_id,
        measurement_item_id=measurement_item_id,
        payload=payload,
    )


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/mark-billed",
    response_model=MobileMeasurementBatchRead,
)
def mark_measurement_batch_billed(
    site_id: int,
    batch_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).set_site_batch_billing_status(
        site_id=site_id,
        batch_id=batch_id,
        billing_status="billed",
        current_user=current_user,
    )


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/mark-open",
    response_model=MobileMeasurementBatchRead,
)
def mark_measurement_batch_open(
    site_id: int,
    batch_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).set_site_batch_billing_status(
        site_id=site_id, batch_id=batch_id, billing_status="submitted"
    )


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/mark-reviewed",
    response_model=MobileMeasurementBatchRead,
)
def mark_measurement_batch_reviewed(
    site_id: int,
    batch_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    logger.info(
        "Measurement mark-reviewed endpoint called: site_id=%s batch_id=%s actor_user_id=%s actor_role=%s",
        site_id,
        batch_id,
        current_user.id,
        current_user.role.value if current_user.role else None,
    )
    return MeasurementService(db).set_site_batch_reviewed(site_id=site_id, batch_id=batch_id)


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/reset-to-submitted",
    response_model=list[MobileMeasurementItemRead],
)
def reset_measurement_batch_to_submitted(
    site_id: int,
    batch_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> list[MobileMeasurementItemRead]:
    return MeasurementService(db).reset_site_batch_to_submitted(
        site_id=site_id,
        batch_id=batch_id,
    )


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/restore",
    response_model=MobileMeasurementBatchRead,
)
def restore_measurement_batch(
    site_id: int,
    batch_id: int,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MobileMeasurementBatchRead:
    return MeasurementService(db).restore_site_batch(
        site_id=site_id,
        batch_id=batch_id,
    )


@router.delete("/{site_id}/measurement-batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_measurement_batch(
    site_id: int,
    batch_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> None:
    MeasurementService(db).delete_site_batch(
        site_id=site_id,
        batch_id=batch_id,
        current_user=current_user,
    )


@router.get("/{site_id}/measurement-batches/{batch_id}/pdf")
def download_measurement_batch_pdf(
    site_id: int,
    batch_id: int,
    mode: str = Query("checked", pattern="^(checked|original)$"),
    _user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> Response:
    content, filename = MeasurementPdfService(db).build_batch_pdf(
        site_id=site_id,
        batch_id=batch_id,
        mode=mode,
    )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.post(
    "/{site_id}/measurement-batches/{batch_id}/items/{measurement_item_id}/entries",
    response_model=MeasurementEntryRead,
)
def create_measurement_entry(
    site_id: int,
    batch_id: int,
    measurement_item_id: int,
    payload: MeasurementEntryCreate,
    user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MeasurementEntryRead:
    return MeasurementService(db).create_site_entry(
        site_id=site_id,
        batch_id=batch_id,
        measurement_item_id=measurement_item_id,
        current_user=user,
        payload=payload,
    )


@router.patch(
    "/{site_id}/measurement-batches/{batch_id}/entries/{entry_id}",
    response_model=MeasurementEntryRead,
)
def update_measurement_entry(
    site_id: int,
    batch_id: int,
    entry_id: int,
    payload: MeasurementEntryCreate,
    _user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MeasurementEntryRead:
    return MeasurementService(db).update_site_entry(
        site_id=site_id,
        batch_id=batch_id,
        entry_id=entry_id,
        payload=payload,
    )


@router.post(
    "/{site_id}/measurement-timesheet/import",
    response_model=MeasurementImportResponse,
)
async def import_measurement_timesheet(
    site_id: int,
    file: UploadFile = File(...),
    import_mode: str = Form("existing"),
    measurement_base_id: int | None = Form(None),
    measurement_base_name: str | None = Form(None),
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> MeasurementImportResponse:
    file_name = file.filename or "zeitenliste.pdf"
    if not file_name.lower().endswith(".pdf"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bitte eine PDF-Datei hochladen.")

    pdf_content = await file.read()
    summary, items = MeasurementService(db).import_timesheet(
        site_id,
        file_name=file_name,
        pdf_content=pdf_content,
        import_mode=import_mode,
        measurement_base_id=measurement_base_id,
        measurement_base_name=measurement_base_name,
    )
    document_result = store_timesheet_pdf_in_project_files(
        db=db,
        site_id=site_id,
        current_user=current_user,
        file_name=file_name,
        pdf_content=pdf_content,
        content_type=file.content_type,
    )
    return MeasurementImportResponse(
        **summary,
        **document_result,
        items=[MeasurementItemRead.model_validate(item) for item in items],
    )


def store_timesheet_pdf_in_project_files(
    *,
    db: Session,
    site_id: int,
    current_user: User,
    file_name: str,
    pdf_content: bytes,
    content_type: str | None,
) -> dict[str, object]:
    try:
        folder = ProjectFolderService(db).get_project_folder_for_site_by_key(
            site_id,
            TIMESHEET_DOCUMENTATION_FOLDER_KEY,
            current_user,
        )
        uploaded = ProjectStorageService().upload_file_to_folder_without_overwrite(
            drive_id=folder.external_drive_id,
            folder_item_id=folder.external_item_id,
            filename=file_name,
            content=pdf_content,
            content_type=content_type or "application/pdf",
        )
    except HTTPException as error:
        detail = error.detail if isinstance(error.detail, str) else "Speicherung fehlgeschlagen."
        return {
            "timesheet_document_saved": False,
            "timesheet_document_name": None,
            "timesheet_document_error": detail,
        }

    return {
        "timesheet_document_saved": True,
        "timesheet_document_name": uploaded.get("name") or file_name,
        "timesheet_document_error": None,
    }

@router.get("/{site_id}/removal-plan", response_model=SiteRemovePlan)
def site_removal_plan(
    site_id: int,
    _user: User = Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> SiteRemovePlan:
    return SiteRemovePlan(action=SiteService(db).remove_plan(site_id))


@router.post("/{site_id}/remove", response_model=SiteRemoveResponse)
def remove_site(
    site_id: int,
    current_user: User = Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> SiteRemoveResponse:
    action, site = SiteService(db).remove_site(site_id, current_user.id)
    return SiteRemoveResponse(action=action, site=SiteRead.model_validate(site) if site else None)


@router.delete("/{site_id}", response_model=SiteRemoveResponse)
def delete_site(
    site_id: int,
    current_user: User = Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> SiteRemoveResponse:
    action, site = SiteService(db).remove_site(site_id, current_user.id)
    return SiteRemoveResponse(action=action, site=SiteRead.model_validate(site) if site else None)


@router.post("", response_model=SiteRead, status_code=201)
def create_site(
    payload: SiteCreate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).create_site(payload, current_user.id)
    return SiteRead.model_validate(site)


@router.patch("/{site_id}", response_model=SiteRead)
def update_site(
    site_id: int,
    payload: SiteUpdate,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).update_site(site_id, payload, current_user.id)
    return SiteRead.model_validate(site)


@router.post("/{site_id}/close", response_model=SiteRead)
def close_site(
    site_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).close_site(site_id, current_user.id)
    return SiteRead.model_validate(site)


@router.post("/{site_id}/check-location", response_model=SiteRead)
def check_site_location(
    site_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).check_location(site_id, current_user.id)
    return SiteRead.model_validate(site)


@router.post("/{site_id}/reactivate", response_model=SiteRead)
def reactivate_site(
    site_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).reactivate_site(site_id, current_user.id)
    return SiteRead.model_validate(site)
