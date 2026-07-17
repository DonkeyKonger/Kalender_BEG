from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import ToolIssueReason, ToolIssueStatus, ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.models.vehicle import Vehicle
from app.schemas.mobile import (
    MobilePersonalFileResponse,
    MobilePersonalFileTool,
    MobilePersonalFileVehicle,
    MobileToolIssueSummary,
)
from app.services.absence_service import AbsenceService
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
        tools = self._tools(person_id=person.id)
        return MobilePersonalFileResponse(
            current_year=year,
            remaining_vacation_days=absence_summary.remaining_vacation_days,
            total_vacation_days=absence_summary.total_vacation_days,
            sick_days=absence_summary.sick_days,
            vehicle=self._vehicle(person_id=person.id),
            tool_count=len(tools),
            tool_preview=tools[:3],
        )

    def list_tools(self, *, current_user: User) -> list[MobilePersonalFileTool]:
        person = self._current_person(current_user)
        return self._tools(person_id=person.id)

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
        rows = self.db.execute(
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
        ).mappings().all()
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
            MobilePersonalFileTool.model_validate({
                **row,
                "open_issue_reports": reports_by_tool_id.get(row["id"], []),
            })
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
