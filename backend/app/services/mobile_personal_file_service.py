from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.absence import Absence
from app.models.enums import (
    AbsenceType,
    ToolIssueReason,
    ToolIssueStatus,
    ToolMaterialStatus,
    UserRole,
)
from app.models.person import Person
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.models.vehicle import Vehicle
from app.schemas.person_hours_account import PersonHoursAccountRead
from app.schemas.mobile import (
    MobilePersonalFileHoursAccount,
    MobilePersonalFileAbsenceEntry,
    MobilePersonalFileAbsenceResponse,
    MobilePersonalFileAbsenceWeek,
    MobilePersonalFileResponse,
    MobilePersonalFileTool,
    MobilePersonalFileVehicle,
    MobileToolIssueSummary,
)
from app.services.absence_service import AbsenceService
from app.services.person_hours_account_service import PersonHoursAccountService
from app.services.tool_material_service import natural_beg_number_key


PERSONAL_FILE_TIMEZONE = ZoneInfo("Europe/Berlin")


class MobilePersonalFileService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_summary(
        self,
        *,
        current_user: User,
        today: date | None = None,
    ) -> MobilePersonalFileResponse:
        person = self._current_person(current_user)
        current_date = today or datetime.now(PERSONAL_FILE_TIMEZONE).date()
        year = current_date.year
        absence_summary = AbsenceService(self.db).get_person_year_summary(
            person=person,
            year=year,
        )
        hours_account = PersonHoursAccountService(self.db).get_account(person_id=person.id)
        tools = self._tools(person_id=person.id)
        return MobilePersonalFileResponse(
            current_year=year,
            remaining_vacation_days=absence_summary.remaining_vacation_days,
            total_vacation_days=absence_summary.total_vacation_days,
            sick_days=absence_summary.sick_days,
            hours_account=self._hours_account(hours_account),
            vehicle=self._vehicle(person_id=person.id),
            tool_count=len(tools),
            tool_preview=tools[:3],
        )

    def list_tools(self, *, current_user: User) -> list[MobilePersonalFileTool]:
        person = self._current_person(current_user)
        return self._tools(person_id=person.id)

    def get_absence_details(
        self,
        *,
        current_user: User,
        year: int,
        absence_type: AbsenceType,
    ) -> MobilePersonalFileAbsenceResponse:
        if absence_type not in (AbsenceType.VACATION, AbsenceType.SICK):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "In der persönlichen Akte sind nur Urlaub und Krankheit verfügbar.",
            )
        person = self._current_person(current_user)
        absence_data = AbsenceService(self.db).get_person_year_data(person=person, year=year)
        summary = absence_data.summary
        return MobilePersonalFileAbsenceResponse(
            year=year,
            absence_type=absence_type,
            remaining_vacation_days=summary.remaining_vacation_days,
            total_vacation_days=summary.total_vacation_days,
            taken_vacation_days=summary.vacation_days,
            sick_days=summary.sick_days,
            weeks=_build_absence_weeks(
                absences=absence_data.absences,
                year=year,
                absence_type=absence_type,
            ),
        )

    def _current_person(self, current_user: User) -> Person:
        if current_user.role != UserRole.MONTEUR:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Die persönliche Akte ist nur für Monteure verfügbar.",
            )
        if current_user.person_id is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Für deinen Benutzer ist kein Monteurprofil hinterlegt.",
            )
        person = self.db.scalar(
            select(Person).where(
                Person.id == current_user.person_id,
                Person.deleted_at.is_(None),
            )
        )
        if person is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Das hinterlegte Monteurprofil ist nicht verfügbar.",
            )
        return person

    @staticmethod
    def _hours_account(hours_account: PersonHoursAccountRead) -> MobilePersonalFileHoursAccount:
        latest_entry = hours_account.entries[0] if hours_account.entries else None
        return MobilePersonalFileHoursAccount(
            current_balance_minutes=hours_account.current_balance_minutes,
            last_entry_at=latest_entry.created_at if latest_entry is not None else None,
        )

    def _vehicle(self, *, person_id: int) -> MobilePersonalFileVehicle | None:
        vehicle = self.db.scalar(
            select(Vehicle)
            .where(
                Vehicle.assigned_person_id == person_id,
                Vehicle.is_active.is_(True),
            )
            .order_by(Vehicle.updated_at.desc(), Vehicle.id.desc())
        )
        if vehicle is None:
            return None
        return MobilePersonalFileVehicle(
            id=vehicle.id,
            license_plate=vehicle.license_plate,
            manufacturer=vehicle.manufacturer,
        )

    def _tools(self, *, person_id: int) -> list[MobilePersonalFileTool]:
        rows = (
            self.db.execute(
                select(
                    ToolMaterialItem.id,
                    ToolMaterialItem.category,
                    ToolMaterialItem.beg_number,
                    ToolMaterialItem.manufacturer,
                    ToolMaterialItem.designation,
                    ToolMaterialItem.device_number,
                    ToolMaterialItem.item_date,
                ).where(
                    ToolMaterialItem.employee_id == person_id,
                    ToolMaterialItem.status == ToolMaterialStatus.ISSUED,
                )
            )
            .mappings()
            .all()
        )
        tool_ids = [row["id"] for row in rows]
        reports_by_tool_id: dict[int, list[MobileToolIssueSummary]] = {}
        if tool_ids:
            reports = list(
                self.db.scalars(
                    select(ToolIssueReport)
                    .where(
                        ToolIssueReport.tool_id.in_(tool_ids),
                        ToolIssueReport.reporter_employee_id == person_id,
                        ToolIssueReport.status == ToolIssueStatus.OPEN,
                        ToolIssueReport.resolved_at.is_(None),
                    )
                    .order_by(ToolIssueReport.created_at.desc(), ToolIssueReport.id.desc())
                ).all()
            )
            for report in reports:
                if report.tool_id is None:
                    continue
                reports_by_tool_id.setdefault(report.tool_id, []).append(
                    MobileToolIssueSummary(
                        id=report.id,
                        reason=report.reason,
                        status=report.status.value,
                        description=(
                            "Das Werkzeug wurde als defekt gemeldet."
                            if report.reason == ToolIssueReason.DEFECTIVE
                            else "Das Werkzeug wurde als entwendet gemeldet."
                        ),
                        created_at=report.created_at,
                    )
                )
        tools = [
            MobilePersonalFileTool.model_validate(
                {
                    **row,
                    "open_issue_reports": reports_by_tool_id.get(row["id"], []),
                }
            )
            for row in rows
        ]
        return sorted(
            tools,
            key=lambda item: (
                item.item_date is None,
                -item.item_date.toordinal() if item.item_date is not None else 0,
                natural_beg_number_key(item.beg_number),
            ),
        )


def _build_absence_weeks(
    *,
    absences: tuple[Absence, ...],
    year: int,
    absence_type: AbsenceType,
) -> list[MobilePersonalFileAbsenceWeek]:
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    grouped_entries: dict[tuple[int, int, date, date], list[MobilePersonalFileAbsenceEntry]] = {}

    for absence in absences:
        if absence.absence_type != absence_type:
            continue
        clipped_start = max(absence.start_date, year_start)
        clipped_end = min(absence.end_date, year_end)
        cursor = clipped_start
        while cursor <= clipped_end:
            week_start = cursor - timedelta(days=cursor.weekday())
            week_end = week_start + timedelta(days=6)
            calendar_segment_start = max(clipped_start, week_start)
            calendar_segment_end = min(clipped_end, week_end)
            weekdays = [
                calendar_segment_start + timedelta(days=offset)
                for offset in range((calendar_segment_end - calendar_segment_start).days + 1)
                if (calendar_segment_start + timedelta(days=offset)).weekday() < 5
            ]
            if weekdays:
                iso_year, iso_week, _ = week_start.isocalendar()
                key = (iso_year, iso_week, week_start, week_end)
                grouped_entries.setdefault(key, []).append(
                    MobilePersonalFileAbsenceEntry(
                        source_id=absence.id,
                        absence_type=absence.absence_type,
                        start_date=weekdays[0],
                        end_date=weekdays[-1],
                        day_count=len(weekdays),
                    )
                )
            cursor = week_end + timedelta(days=1)

    weeks = [
        MobilePersonalFileAbsenceWeek(
            iso_year=iso_year,
            iso_week=iso_week,
            week_start=week_start,
            week_end=week_end,
            entries=sorted(
                entries,
                key=lambda entry: (entry.start_date, entry.end_date, entry.source_id),
            ),
        )
        for (iso_year, iso_week, week_start, week_end), entries in grouped_entries.items()
    ]
    return sorted(weeks, key=lambda week: (week.week_start, week.iso_week), reverse=True)
