from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.models.vehicle import VehicleAsset
from app.schemas.mobile import (
    MobilePersonalFileResponse,
    MobilePersonalFileTool,
    MobilePersonalFileVehicle,
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
        asset = self.db.scalar(
            select(VehicleAsset)
            .where(
                VehicleAsset.assigned_person_id == person_id,
                VehicleAsset.is_active.is_(True),
            )
            .order_by(VehicleAsset.updated_at.desc(), VehicleAsset.id.desc())
        )
        if asset is None:
            return None
        return MobilePersonalFileVehicle(
            name=(
                asset.label
                or asset.vehicle_registration
                or asset.fleet_number
                or f"Fahrzeug {asset.external_id}"
            ),
            vehicle_registration=asset.vehicle_registration,
            fleet_number=asset.fleet_number,
        )

    def _tools(self, *, person_id: int) -> list[MobilePersonalFileTool]:
        rows = self.db.execute(
            select(
                ToolMaterialItem.id,
                ToolMaterialItem.category,
                ToolMaterialItem.beg_number,
                ToolMaterialItem.manufacturer,
                ToolMaterialItem.designation,
                ToolMaterialItem.item_date,
            ).where(
                ToolMaterialItem.employee_id == person_id,
                ToolMaterialItem.status == ToolMaterialStatus.ISSUED,
            )
        ).mappings().all()
        tools = [MobilePersonalFileTool.model_validate(row) for row in rows]
        return sorted(
            tools,
            key=lambda item: (
                item.item_date is None,
                -item.item_date.toordinal() if item.item_date is not None else 0,
                natural_beg_number_key(item.beg_number),
            ),
        )
