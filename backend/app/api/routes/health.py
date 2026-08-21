from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.build_info import get_build_revision
from app.core.database import get_db
from app.models.enums import SiteStatus
from app.models.tool_material_item import ToolMaterialItem
from app.scripts.import_bundled_tools import EXPECTED_SHA256, bundled_source_keys

router = APIRouter()

BACKEND_BUILD = "site-status-v2-20260525"


@router.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "build": BACKEND_BUILD,
        "revision": get_build_revision(),
        "site_status_values": [status.value for status in SiteStatus],
    }


@router.get("/health/tool-import")
def tool_import_health(
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    expected_keys = bundled_source_keys()
    imported_rows = int(
        db.scalar(
            select(func.count(ToolMaterialItem.id)).where(
                ToolMaterialItem.import_key.in_(expected_keys)
            )
        )
        or 0
    )
    ready = imported_rows == len(expected_keys)
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "status": "ok" if ready else "pending",
        "source_sha256": EXPECTED_SHA256,
        "expected_rows": len(expected_keys),
        "imported_rows": imported_rows,
    }
