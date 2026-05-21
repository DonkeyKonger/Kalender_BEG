from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.user import User
from app.schemas.site import SiteCreate, SiteGeocodeSearchResult, SiteMapResponse, SiteRead, SiteUpdate
from app.services.geo_service import search_geocoding_candidates
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
