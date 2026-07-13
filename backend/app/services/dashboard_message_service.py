from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.dashboard_message_dismissal import DashboardMessageDismissal
from app.models.dashboard_note import DashboardNote
from app.models.user import User
from app.schemas.measurement import DashboardMessageRead, DashboardMessagesSummaryRead
from app.services.measurement_service import MeasurementService

DASHBOARD_NOTE_SHARED_MESSAGE_TYPE = "dashboard_note_shared"


class DashboardMessageService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.measurements = MeasurementService(db)

    def get_summary(self, *, limit: int, current_user: User) -> DashboardMessagesSummaryRead:
        return DashboardMessagesSummaryRead(
            open_count=(
                self.measurements.count_dashboard_submissions(current_user=current_user)
                + self._count_note_share_messages(current_user=current_user)
            ),
            latest_messages=self.list_messages(limit=limit, current_user=current_user),
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
        return sorted(
            [*measurement_messages, *note_messages],
            key=lambda message: (
                message.event_at
                or message.submitted_at
                or datetime.min.replace(tzinfo=timezone.utc)
            ),
            reverse=True,
        )[:limit]

    def dismiss_message(self, *, message_key: str, current_user: User) -> None:
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
        return len(self._list_note_share_messages(current_user=current_user))

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


def dashboard_note_message_key(note: DashboardNote) -> str:
    return f"{DASHBOARD_NOTE_SHARED_MESSAGE_TYPE}:{note.id}:{note.share_revision}"
