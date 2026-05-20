from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.site import SiteCreate, SiteRead, SiteUpdate
from app.services.site_service import SiteService

router = APIRouter(prefix="/sites", tags=["sites"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)


@router.get("", response_model=list[SiteRead])
def list_sites(
    include_closed: bool = False,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[SiteRead]:
    sites = SiteService(db).list_sites(include_closed=include_closed)
    return [SiteRead.model_validate(site) for site in sites]


@router.get("/{site_id}", response_model=SiteRead)
def get_site(
    site_id: int,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).get_site(site_id)
    return SiteRead.model_validate(site)


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


@router.post("/{site_id}/reactivate", response_model=SiteRead)
def reactivate_site(
    site_id: int,
    current_user: User = Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> SiteRead:
    site = SiteService(db).reactivate_site(site_id, current_user.id)
    return SiteRead.model_validate(site)
