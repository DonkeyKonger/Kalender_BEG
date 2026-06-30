from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.services.pdf_export_service import PdfExportService
from app.services.time_entry_weekly_pdf_service import TimeEntryWeeklyPdfService
from app.services.time_entry_xlsx_export_service import TimeEntryXlsxExportService

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
    normalized_start = week_start - timedelta(days=week_start.weekday())
    content = PdfExportService(db).weekly_plan(normalized_start)
    filename = f"wochenplan-{normalized_start.isoformat()}.pdf"
    return pdf_response(content, filename)


@router.get("/time-entries/monthly-xlsx")
def monthly_time_entries_xlsx(
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    current_user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    content = TimeEntryXlsxExportService(db).monthly_export(
        year=year,
        month=month,
        current_user=current_user,
    )
    filename = f"zeiten_export_{year}_{month:02d}.xlsx"
    return xlsx_response(content, filename)


@router.get("/time-entries/weekly-worker-hours.pdf")
def weekly_worker_hours_pdf(
    week_start: date,
    _current_user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    normalized_start = week_start
    content = TimeEntryWeeklyPdfService(db).weekly_worker_hours(week_start=normalized_start)
    iso_week = normalized_start.isocalendar()
    filename = f"arbeitsstunden_kw{iso_week.week:02d}_{iso_week.year}.pdf"
    return pdf_response(content, filename)


@router.get("/time-entries/weekly-worker-xlsx")
def weekly_worker_time_entries_xlsx(
    person_id: int = Query(gt=0),
    week_start: date = Query(),
    current_user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    normalized_start = week_start - timedelta(days=week_start.weekday())
    content = TimeEntryXlsxExportService(db).weekly_worker_export(
        person_id=person_id,
        week_start=normalized_start,
        current_user=current_user,
    )
    iso_week = normalized_start.isocalendar()
    filename = f"lohnpruefung_kw{iso_week.week:02d}_{iso_week.year}_person_{person_id}.xlsx"
    return xlsx_response(content, filename)


@router.get("/time-entries/weekly-workers-xlsx")
def weekly_all_workers_time_entries_xlsx(
    week_start: date = Query(),
    current_user=Depends(CAN_EXPORT),
    db: Session = Depends(get_db),
) -> Response:
    normalized_start = week_start - timedelta(days=week_start.weekday())
    content = TimeEntryXlsxExportService(db).weekly_all_workers_export(
        week_start=normalized_start,
        current_user=current_user,
    )
    iso_week = normalized_start.isocalendar()
    filename = f"Lohnpruefung_KW{iso_week.week:02d}_{iso_week.year}_Alle_Monteure.xlsx"
    return xlsx_response(content, filename)


def pdf_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def xlsx_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
