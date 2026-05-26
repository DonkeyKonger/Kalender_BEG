from fastapi import APIRouter, Depends, File, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
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
    SiteRemoveResponse,
    SiteUpdate,
)
from app.services.geo_service import search_geocoding_candidates
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService
from app.services.site_service import SiteService

router = APIRouter(prefix="/sites", tags=["sites"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_FOLDER_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE, UserRole.MONTEUR)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
CAN_ADMIN = require_roles(UserRole.ADMIN)


@router.get("", response_model=list[SiteRead])
def list_sites(
    include_closed: bool = False,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[SiteRead]:
    sites = SiteService(db).list_sites(include_closed=include_closed)
    return [SiteRead.model_validate(site) for site in sites]


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
    uploaded = ProjectStorageService().upload_file_to_folder(
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
        filename=file.filename,
        content=await file.read(),
        content_type=file.content_type,
    )
    return ProjectFolderDocumentItem.model_validate(uploaded)


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
