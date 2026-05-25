from fastapi import APIRouter

from app.models.enums import SiteStatus

router = APIRouter()

BACKEND_BUILD = "site-status-v2-20260525"


@router.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "build": BACKEND_BUILD,
        "site_status_values": [status.value for status in SiteStatus],
    }
