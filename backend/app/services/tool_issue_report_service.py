from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.enums import ToolIssueStatus, ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.schemas.mobile import MobileToolIssueReportCreate, MobileToolIssueReportRead
from app.services.tool_material_responsibility_service import get_tool_responsible_user


DUPLICATE_REPORT_WINDOW = timedelta(minutes=5)
NO_RESPONSIBLE_USER_MESSAGE = (
    "Aktuell ist kein Werkzeug-Beauftragter hinterlegt. Bitte informiere das Büro."
)


class ToolIssueReportService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def report(
        self,
        *,
        tool_id: int,
        payload: MobileToolIssueReportCreate,
        current_user: User,
    ) -> MobileToolIssueReportRead:
        person = self._current_monteur(current_user)
        request_id = str(payload.request_id)
        existing_request = self.db.scalar(
            select(ToolIssueReport).where(ToolIssueReport.request_id == request_id)
        )
        if existing_request is not None:
            if existing_request.reporter_user_id != current_user.id:
                raise HTTPException(status.HTTP_409_CONFLICT, "Diese Anfrage-ID wurde bereits verwendet.")
            return self._response(existing_request, already_reported=True)

        tool = self.db.scalar(
            select(ToolMaterialItem)
            .where(ToolMaterialItem.id == tool_id)
            .with_for_update()
        )
        if tool is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Das Werkzeug ist nicht mehr verfügbar. Bitte aktualisiere die Liste.",
            )
        if tool.employee_id != person.id or tool.status != ToolMaterialStatus.ISSUED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Das Werkzeug ist dir nicht mehr als ausgegeben zugeordnet. Bitte aktualisiere die Liste.",
            )

        recipient = get_tool_responsible_user(self.db)
        if recipient is None:
            raise HTTPException(status.HTTP_409_CONFLICT, NO_RESPONSIBLE_USER_MESSAGE)

        duplicate = self.db.scalar(
            select(ToolIssueReport)
            .where(
                ToolIssueReport.tool_id == tool.id,
                ToolIssueReport.reporter_employee_id == person.id,
                ToolIssueReport.reason == payload.reason,
                ToolIssueReport.status == ToolIssueStatus.OPEN,
                ToolIssueReport.created_at >= datetime.now(timezone.utc) - DUPLICATE_REPORT_WINDOW,
            )
            .order_by(ToolIssueReport.created_at.desc(), ToolIssueReport.id.desc())
        )
        if duplicate is not None:
            return self._response(duplicate, already_reported=True)

        report = ToolIssueReport(
            tool_id=tool.id,
            tool_id_snapshot=tool.id,
            tool_beg_number_snapshot=tool.beg_number,
            tool_manufacturer_snapshot=tool.manufacturer,
            tool_designation_snapshot=tool.designation,
            reason=payload.reason,
            status=ToolIssueStatus.OPEN,
            reporter_user_id=current_user.id,
            reporter_employee_id=person.id,
            reporter_last_name_snapshot=person.last_name,
            recipient_user_id=recipient.id,
            request_id=request_id,
        )
        self.db.add(report)
        try:
            self.db.commit()
        except IntegrityError as error:
            self.db.rollback()
            raced = self.db.scalar(
                select(ToolIssueReport).where(ToolIssueReport.request_id == request_id)
            )
            if raced is not None and raced.reporter_user_id == current_user.id:
                return self._response(raced, already_reported=True)
            raise HTTPException(status.HTTP_409_CONFLICT, "Diese Meldung wurde bereits gesendet.") from error
        self.db.refresh(report)
        return self._response(report, already_reported=False)

    def _current_monteur(self, current_user: User) -> Person:
        if current_user.role != UserRole.MONTEUR or current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Nur Monteure können Werkzeugmeldungen senden.")
        person = self.db.scalar(
            select(Person).where(
                Person.id == current_user.person_id,
                Person.deleted_at.is_(None),
            )
        )
        if person is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Das Monteurprofil ist nicht verfügbar.")
        return person

    @staticmethod
    def _response(report: ToolIssueReport, *, already_reported: bool) -> MobileToolIssueReportRead:
        return MobileToolIssueReportRead(
            id=report.id,
            status=report.status.value,
            created_at=report.created_at,
            message=(
                "Diese Meldung wurde bereits gesendet."
                if already_reported
                else "Werkzeugmeldung wurde gesendet."
            ),
            already_reported=already_reported,
        )
