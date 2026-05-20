from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.services.pdf_export_service import PdfExportService

router = APIRouter(prefix="/exports", tags=["exports"])

CAN_EXPORT = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE)


@router.get("/daily-plan")
def daily_plan(
    date_: date = Query(alias="date"),
    _user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    content = PdfExportService(db).daily_plan(date_)
    filename = f"tagesplan-{date_.isoformat()}.pdf"
    return pdf_response(content, filename)


@router.get("/weekly-plan")
def weekly_plan(
    week_start: date,
    _user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    normalized_start = week_start
    content = PdfExportService(db).weekly_plan(normalized_start)
    filename = f"wochenplan-{normalized_start.isoformat()}.pdf"
    return pdf_response(content, filename)


def pdf_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
