from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import String, cast, func, literal, select
from sqlalchemy.orm import Session, selectinload

from app.models.dashboard_message_dismissal import DashboardMessageDismissal
from app.models.dashboard_note import DashboardNote
from app.models.enums import ToolIssueReason, ToolIssueStatus
from app.models.tool_issue_report import ToolIssueReport
from app.models.user import User
from app.schemas.measurement import DashboardMessageRead, DashboardMessagesSummaryRead
from app.services.measurement_service import MeasurementService

DASHBOARD_NOTE_SHARED_MESSAGE_TYPE = "dashboard_note_shared"
TOOL_ISSUE_REPORTED_MESSAGE_TYPE = "tool_issue_reported"
BERLIN_TIMEZONE = ZoneInfo("Europe/Berlin")


class DashboardMessageService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.measurements = MeasurementService(db)

    def get_summary(self, *, limit: int, current_user: User) -> DashboardMessagesSummaryRead:
        return DashboardMessagesSummaryRead(
            open_count=self.count_open_messages(current_user=current_user),
            latest_messages=self.list_messages(limit=limit, current_user=current_user),
        )

    def count_open_messages(self, *, current_user: User) -> int:
        return (
            self.measurements.count_dashboard_submissions(current_user=current_user)
            + self._count_note_share_messages(current_user=current_user)
            + self._count_tool_issue_messages(current_user=current_user)
        )

    def list_messages(self, *, limit: int, current_user: User) -> list[DashboardMessageRead]:
        measurement_messages = [
            DashboardMessageRead.model_validate(message.model_dump())
            for message in self.measurements.list_dashboard_submissions(
                limit=limit,
                current_user=current_user,
            )
        ]
        note_messages = self._list_note_share_messages(current_user=current_user)
        tool_issue_messages = self._list_tool_issue_messages(current_user=current_user)
        return sorted(
            [*measurement_messages, *note_messages, *tool_issue_messages],
            key=lambda message: (
                message.event_at
                or message.submitted_at
                or datetime.min.replace(tzinfo=timezone.utc)
            ),
            reverse=True,
        )[:limit]

    def dismiss_message(self, *, message_key: str, current_user: User) -> None:
        if message_key.startswith(f"{TOOL_ISSUE_REPORTED_MESSAGE_TYPE}:"):
            raw_report_id = message_key.partition(":")[2]
            report = self.db.get(ToolIssueReport, int(raw_report_id)) if raw_report_id.isdigit() else None
            if report is None or report.recipient_user_id != current_user.id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Meldung nicht gefunden.")
            report.resolved_at = datetime.now(timezone.utc)
            report.resolved_by_user_id = current_user.id
        self.measurements.dismiss_dashboard_message(
            message_key=message_key,
            current_user=current_user,
        )

    def _list_note_share_messages(self, *, current_user: User) -> list[DashboardMessageRead]:
        dismissed_keys = self._dismissed_note_message_keys(current_user=current_user)
        notes = self.db.scalars(
            select(DashboardNote)
            .options(
                selectinload(DashboardNote.site),
                selectinload(DashboardNote.created_by),
            )
            .where(
                DashboardNote.shared_with_user_id == current_user.id,
                DashboardNote.deleted_at.is_(None),
            )
            .order_by(
                DashboardNote.shared_at.desc(),
                DashboardNote.updated_at.desc(),
                DashboardNote.id.desc(),
            )
        ).all()
        return [
            self._build_note_share_message(note)
            for note in notes
            if dashboard_note_message_key(note) not in dismissed_keys
        ]

    def _count_note_share_messages(self, *, current_user: User) -> int:
        message_key = (
            literal(f"{DASHBOARD_NOTE_SHARED_MESSAGE_TYPE}:")
            + cast(DashboardNote.id, String)
            + literal(":")
            + cast(DashboardNote.share_revision, String)
        )
        is_dismissed = select(DashboardMessageDismissal.id).where(
            DashboardMessageDismissal.user_id == current_user.id,
            DashboardMessageDismissal.message_type == DASHBOARD_NOTE_SHARED_MESSAGE_TYPE,
            DashboardMessageDismissal.message_key == message_key,
        ).exists()
        return self.db.scalar(
            select(func.count(DashboardNote.id)).where(
                DashboardNote.shared_with_user_id == current_user.id,
                DashboardNote.deleted_at.is_(None),
                ~is_dismissed,
            )
        ) or 0

    def _list_tool_issue_messages(self, *, current_user: User) -> list[DashboardMessageRead]:
        dismissed_keys = set(
            self.db.scalars(
                select(DashboardMessageDismissal.message_key).where(
                    DashboardMessageDismissal.user_id == current_user.id,
                    DashboardMessageDismissal.message_type == TOOL_ISSUE_REPORTED_MESSAGE_TYPE,
                )
            ).all()
        )
        reports = self.db.scalars(
            select(ToolIssueReport)
            .where(
                ToolIssueReport.recipient_user_id == current_user.id,
                ToolIssueReport.status == ToolIssueStatus.OPEN,
                ToolIssueReport.resolved_at.is_(None),
            )
            .order_by(ToolIssueReport.created_at.desc(), ToolIssueReport.id.desc())
        ).all()
        return [
            self._build_tool_issue_message(report)
            for report in reports
            if tool_issue_message_key(report) not in dismissed_keys
        ]

    def _count_tool_issue_messages(self, *, current_user: User) -> int:
        message_key = (
            literal(f"{TOOL_ISSUE_REPORTED_MESSAGE_TYPE}:")
            + cast(ToolIssueReport.id, String)
        )
        is_dismissed = select(DashboardMessageDismissal.id).where(
            DashboardMessageDismissal.user_id == current_user.id,
            DashboardMessageDismissal.message_type == TOOL_ISSUE_REPORTED_MESSAGE_TYPE,
            DashboardMessageDismissal.message_key == message_key,
        ).exists()
        return self.db.scalar(
            select(func.count(ToolIssueReport.id)).where(
                ToolIssueReport.recipient_user_id == current_user.id,
                ToolIssueReport.status == ToolIssueStatus.OPEN,
                ToolIssueReport.resolved_at.is_(None),
                ~is_dismissed,
            )
        ) or 0

    def _dismissed_note_message_keys(self, *, current_user: User) -> set[str]:
        return set(
            self.db.scalars(
                select(DashboardMessageDismissal.message_key).where(
                    DashboardMessageDismissal.user_id == current_user.id,
                    DashboardMessageDismissal.message_type == DASHBOARD_NOTE_SHARED_MESSAGE_TYPE,
                )
            ).all()
        )

    @staticmethod
    def _build_note_share_message(note: DashboardNote) -> DashboardMessageRead:
        creator_name = note.created_by.display_name if note.created_by else "Büronutzer"
        return DashboardMessageRead(
            message_key=dashboard_note_message_key(note),
            message_type=DASHBOARD_NOTE_SHARED_MESSAGE_TYPE,
            title=f"Neue Notiz von {creator_name}",
            status="completed" if note.completed else "open",
            event_at=note.shared_at,
            note_id=note.id,
            site_id=note.site_id,
            site_name=note.site.name if note.site else None,
            site_number=note.site.site_number if note.site else None,
            submitted_by_name=creator_name,
            submitted_at=note.created_at,
            note_preview=note.text[:180],
            note_due_date=note.due_date,
            note_created_at=note.created_at,
        )

    @staticmethod
    def _build_tool_issue_message(report: ToolIssueReport) -> DashboardMessageRead:
        reason_label = (
            "Maschine defekt"
            if report.reason == ToolIssueReason.DEFECTIVE
            else "Maschine entwendet"
        )
        action_label = "als defekt" if report.reason == ToolIssueReason.DEFECTIVE else "als entwendet"
        tool_label = " ".join(
            value for value in (report.tool_manufacturer_snapshot, report.tool_designation_snapshot) if value
        )
        identifier = (
            f"BEG {report.tool_beg_number_snapshot}"
            if report.tool_beg_number_snapshot
            else f"Werkzeug #{report.tool_id_snapshot}"
        )
        created_at = report.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        visible_date = created_at.astimezone(BERLIN_TIMEZONE).strftime("%d.%m.%Y")
        return DashboardMessageRead(
            message_key=tool_issue_message_key(report),
            message_type=TOOL_ISSUE_REPORTED_MESSAGE_TYPE,
            title=f"Werkzeugmeldung: {reason_label}",
            status=report.status.value,
            event_at=report.created_at,
            submitted_by_name=report.reporter_last_name_snapshot,
            submitted_at=report.created_at,
            message_text=(
                f"{identifier} – {tool_label} wurde am {visible_date} von "
                f"{report.reporter_last_name_snapshot} {action_label} gemeldet."
            ),
            tool_id=report.tool_id_snapshot,
            tool_issue_report_id=report.id,
            tool_issue_reason=report.reason.value,
            target_area="miscellaneous",
            target_tab="toolsMaterial",
        )


def dashboard_note_message_key(note: DashboardNote) -> str:
    return f"{DASHBOARD_NOTE_SHARED_MESSAGE_TYPE}:{note.id}:{note.share_revision}"


def tool_issue_message_key(report: ToolIssueReport) -> str:
    return f"{TOOL_ISSUE_REPORTED_MESSAGE_TYPE}:{report.id}"
