from datetime import date, datetime, time

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.enums import UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import TimeEntryCreate, TimeEntryUpdate

GPS_TIME_REVIEW_TOLERANCE_MINUTES = 15
OPEN_TIME_REVIEW_STATUS = "open"
TERMINAL_TIME_REVIEW_STATUSES = {"manually_approved", "corrected", "auto_closed_by_deadline"}


class TimeEntryService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_entries(
        self,
        *,
        current_user: User,
        person_id: int | None = None,
        site_id: int | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> list[WorkTimeEntry]:
        if date_from is not None and date_to is not None and date_to < date_from:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "date_to darf nicht vor date_from liegen.")
        effective_person_id = self._effective_person_id(current_user, person_id)
        statement = (
            select(WorkTimeEntry)
            .options(selectinload(WorkTimeEntry.person), selectinload(WorkTimeEntry.site))
            .order_by(WorkTimeEntry.work_date.desc(), WorkTimeEntry.id.desc())
        )
        if effective_person_id is not None:
            statement = statement.where(WorkTimeEntry.person_id == effective_person_id)
        if site_id is not None:
            statement = statement.where(WorkTimeEntry.site_id == site_id)
        if date_from is not None:
            statement = statement.where(WorkTimeEntry.work_date >= date_from)
        if date_to is not None:
            statement = statement.where(WorkTimeEntry.work_date <= date_to)
        return list(self.db.scalars(statement))

    def create_entry(self, payload: TimeEntryCreate, current_user: User) -> WorkTimeEntry:
        self._ensure_can_write_person(current_user, payload.person_id)
        self._ensure_person_exists(payload.person_id)
        self._ensure_site_exists(payload.site_id)
        self._ensure_assignment_matches(payload.assignment_id, payload.person_id, payload.site_id)
        values = payload.model_dump()
        values["break_minutes"] = values.get("break_minutes") or 0
        values["travel_minutes"] = values.get("travel_minutes") or 0
        values["work_minutes"] = self._resolve_work_minutes(
            start_time=values.get("start_time"),
            end_time=values.get("end_time"),
            break_minutes=values["break_minutes"],
            work_minutes=values.get("work_minutes"),
        )
        values["note"] = clean_optional_text(values.get("note"))
        entry = WorkTimeEntry(**values, created_by_user_id=current_user.id)
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def update_entry(self, entry_id: int, payload: TimeEntryUpdate, current_user: User) -> WorkTimeEntry:
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        values = payload.model_dump(exclude_unset=True)
        next_person_id = values.get("person_id", entry.person_id)
        next_site_id = values.get("site_id", entry.site_id)
        if "person_id" in values:
            self._ensure_can_write_person(current_user, next_person_id)
            self._ensure_person_exists(next_person_id)
        if "site_id" in values:
            self._ensure_site_exists(next_site_id)
        if "assignment_id" in values or "person_id" in values or "site_id" in values:
            self._ensure_assignment_matches(values.get("assignment_id", entry.assignment_id), next_person_id, next_site_id)

        for field, value in values.items():
            if field == "note":
                value = clean_optional_text(value)
            setattr(entry, field, value)

        entry.break_minutes = entry.break_minutes or 0
        entry.travel_minutes = entry.travel_minutes or 0
        entry.work_minutes = self._resolve_work_minutes(
            start_time=entry.start_time,
            end_time=entry.end_time,
            break_minutes=entry.break_minutes,
            work_minutes=entry.work_minutes,
        )
        if entry.status == "reviewed" and entry.reviewed_by_user_id is None:
            entry.reviewed_by_user_id = current_user.id
            entry.reviewed_at = datetime.now().astimezone()

        self.db.commit()
        self.db.refresh(entry)
        return entry

    def approve_time_review(self, entry_id: int, current_user: User) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._mark_time_review(
            entry,
            status_value="manually_approved",
            method="manual_confirmed",
            current_user=current_user,
        )
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def correct_time_review(self, entry_id: int, corrected_work_minutes: int, current_user: User) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        if corrected_work_minutes < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Korrigierte Arbeitszeit darf nicht negativ sein.")
        if entry.original_work_minutes is None:
            entry.original_work_minutes = entry.work_minutes
        entry.corrected_work_minutes = corrected_work_minutes
        entry.work_minutes = corrected_work_minutes
        self._mark_time_review(
            entry,
            status_value="corrected",
            method="manual_correction",
            current_user=current_user,
        )
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def auto_close_deadline_reviews(
        self,
        entries: list[WorkTimeEntry],
        gps_minutes_by_entry_id: dict[int, int | None],
        *,
        today: date | None = None,
    ) -> bool:
        check_date = today or date.today()
        if check_date.day < 5:
            return False
        current_month_start = date(check_date.year, check_date.month, 1)
        changed = False
        for entry in entries:
            if entry.work_date >= current_month_start:
                continue
            if not self.is_open_time_review_case(entry, gps_minutes_by_entry_id.get(entry.id)):
                continue
            entry.time_review_status = "auto_closed_by_deadline"
            entry.time_review_method = "deadline"
            entry.status = "reviewed"
            entry.reviewed_by_user_id = None
            entry.reviewed_at = datetime.now().astimezone()
            changed = True
        if changed:
            self.db.commit()
        return changed

    @staticmethod
    def is_open_time_review_case(entry: WorkTimeEntry, gps_minutes: int | None) -> bool:
        review_status = getattr(entry, "time_review_status", OPEN_TIME_REVIEW_STATUS) or OPEN_TIME_REVIEW_STATUS
        if review_status in TERMINAL_TIME_REVIEW_STATUSES:
            return False
        manual_minutes = getattr(entry, "work_minutes", None)
        if manual_minutes is None and gps_minutes is None:
            return False
        if manual_minutes is None or gps_minutes is None:
            return True
        return abs(gps_minutes - manual_minutes) > GPS_TIME_REVIEW_TOLERANCE_MINUTES

    def _get_entry(self, entry_id: int) -> WorkTimeEntry:
        entry = self.db.get(WorkTimeEntry, entry_id)
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Arbeitszeit nicht gefunden.")
        return entry

    def _effective_person_id(self, current_user: User, requested_person_id: int | None) -> int | None:
        if current_user.role != UserRole.MONTEUR:
            return requested_person_id
        if current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
        if requested_person_id is not None and requested_person_id != current_user.person_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Monteure duerfen nur eigene Arbeitszeiten sehen.")
        return current_user.person_id

    def _ensure_can_write_person(self, current_user: User, person_id: int) -> None:
        if current_user.role != UserRole.MONTEUR:
            return
        if current_user.person_id != person_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Monteure duerfen nur eigene Arbeitszeiten erfassen.")

    def _ensure_can_review_time(self, current_user: User) -> None:
        if current_user.role in {UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE}:
            return
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Arbeitszeiten duerfen nur durch Buero oder Projektleitung geprueft werden.")

    @staticmethod
    def _mark_time_review(
        entry: WorkTimeEntry,
        *,
        status_value: str,
        method: str,
        current_user: User,
    ) -> None:
        entry.time_review_status = status_value
        entry.time_review_method = method
        entry.status = "reviewed"
        entry.reviewed_by_user_id = current_user.id
        entry.reviewed_at = datetime.now().astimezone()

    def _ensure_person_exists(self, person_id: int) -> None:
        if self.db.get(Person, person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")

    def _ensure_site_exists(self, site_id: int | None) -> None:
        if site_id is not None and self.db.get(Site, site_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Baustelle nicht gefunden.")

    def _ensure_assignment_matches(self, assignment_id: int | None, person_id: int, site_id: int | None) -> None:
        if assignment_id is None:
            return
        assignment = self.db.get(Assignment, assignment_id)
        if assignment is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einsatz nicht gefunden.")
        if assignment.person_id != person_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einsatz passt nicht zur Person.")
        if site_id is not None and assignment.site_id != site_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einsatz passt nicht zur Baustelle.")

    def _resolve_work_minutes(
        self,
        *,
        start_time: time | None,
        end_time: time | None,
        break_minutes: int,
        work_minutes: int | None,
    ) -> int:
        if work_minutes is not None:
            if work_minutes < 0:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Arbeitszeit darf nicht negativ sein.")
            return work_minutes
        if start_time is None or end_time is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Arbeitszeit braucht Minuten oder Start-/Endzeit.")
        start_minutes = start_time.hour * 60 + start_time.minute
        end_minutes = end_time.hour * 60 + end_time.minute
        if end_minutes <= start_minutes:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Endzeit muss nach Startzeit liegen.")
        calculated = end_minutes - start_minutes - break_minutes
        if calculated < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pause darf die Arbeitszeit nicht uebersteigen.")
        return calculated


def clean_optional_text(value: str | None) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
