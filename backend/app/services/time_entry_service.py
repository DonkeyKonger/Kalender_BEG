from datetime import date, datetime, time, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, PersonType, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import TimeEntryCreate, TimeEntryUpdate
from app.services.person_hours_account_service import OFFICE_ONLY_TIME_ENTRY_NOTE, PersonHoursAccountService

GPS_TIME_REVIEW_TOLERANCE_MINUTES = 15
OPEN_TIME_REVIEW_STATUS = "open"
TERMINAL_TIME_REVIEW_STATUSES = {
    "manually_approved",
    "corrected",
    "not_verifiable",
    "clarification",
    "auto_closed_by_deadline",
}
WEEKLY_REVIEW_STATUS_REVIEWED = "reviewed"
WEEKLY_REVIEW_STATUS_RESET = "reset"


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
            .options(
                selectinload(WorkTimeEntry.person),
                selectinload(WorkTimeEntry.site),
                selectinload(WorkTimeEntry.original_site),
            )
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
        if payload.note == OFFICE_ONLY_TIME_ENTRY_NOTE:
            self._ensure_week_is_open(payload.person_id, payload.work_date)
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
        self._ensure_no_time_overlap(
            person_id=values["person_id"],
            work_date=values["work_date"],
            start_time=values.get("start_time"),
            end_time=values.get("end_time"),
        )
        values["note"] = clean_optional_text(values.get("note"))
        values["original_site_id"] = values.get("site_id")
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

        next_work_date = values.get("work_date", entry.work_date)
        next_start_time = values.get("start_time", entry.start_time)
        next_end_time = values.get("end_time", entry.end_time)
        self._ensure_no_time_overlap(
            person_id=next_person_id,
            work_date=next_work_date,
            start_time=next_start_time,
            end_time=next_end_time,
            exclude_entry_id=entry.id,
        )

        for field, value in values.items():
            if field == "note":
                value = clean_optional_text(value)
            setattr(entry, field, value)
        if "site_id" in values and entry.time_review_method != "assign_site":
            entry.original_site_id = entry.site_id

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

    def delete_entry(self, entry_id: int, current_user: User) -> None:
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        self._ensure_entry_can_be_deleted(entry)
        self.db.delete(entry)
        self.db.commit()

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

    def set_payroll_row_review(self, entry_id: int, *, reviewed: bool, current_user: User) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        if reviewed:
            entry.payroll_reviewed_by_user_id = current_user.id
            entry.payroll_reviewed_at = datetime.now().astimezone()
        else:
            entry.payroll_reviewed_by_user_id = None
            entry.payroll_reviewed_at = None
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def set_payroll_time_correction(
        self,
        entry_id: int,
        *,
        start_time: time | None,
        end_time: time | None,
        work_minutes: int | None,
        current_user: User,
        break_minutes: int | None = None,
    ) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        if work_minutes is not None and work_minutes <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Büro-geprüfte Arbeitszeit muss größer als 0 sein.")
        if break_minutes is not None and break_minutes < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Büro-geprüfte Pause darf nicht negativ sein.")
        if start_time is None and end_time is None and work_minutes is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bitte mindestens eine Bürozeit eintragen.")
        if start_time is not None and end_time is not None:
            calculated_minutes = self._payroll_duration_minutes(
                start_time,
                end_time,
                break_minutes if break_minutes is not None else entry.break_minutes,
            )
            if calculated_minutes is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Beginn, Ende und Pause ergeben keine plausible Arbeitszeit.",
                )
            work_minutes = calculated_minutes

        entry.payroll_corrected_start_time = start_time
        entry.payroll_corrected_end_time = end_time
        entry.payroll_corrected_break_minutes = break_minutes
        entry.payroll_corrected_work_minutes = work_minutes
        self.db.commit()
        self.db.refresh(entry)
        return entry

    def set_payroll_date_correction(
        self,
        entry_id: int,
        *,
        work_date: date,
        current_user: User,
    ) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)
        if entry.work_date == work_date:
            return entry
        if entry.work_date.isocalendar()[:2] != work_date.isocalendar()[:2]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Der Eintrag kann nur innerhalb derselben Kalenderwoche verschoben werden.")

        self._ensure_no_time_overlap(
            person_id=entry.person_id,
            work_date=work_date,
            start_time=entry.start_time,
            end_time=entry.end_time,
            exclude_entry_id=entry.id,
        )
        if entry.original_work_date is None:
            entry.original_work_date = entry.work_date
        entry.work_date = work_date
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

    def apply_time_review_decision(
        self,
        entry_id: int,
        *,
        decision: str,
        current_user: User,
        final_work_minutes: int | None = None,
        reviewed_site_id: int | None = None,
    ) -> WorkTimeEntry:
        self._ensure_can_review_time(current_user)
        entry = self._get_entry(entry_id)
        self._ensure_can_write_person(current_user, entry.person_id)

        if reviewed_site_id is not None:
            self._ensure_site_exists(reviewed_site_id)
            if entry.original_site_id is None:
                entry.original_site_id = entry.site_id
            entry.site_id = reviewed_site_id

        if decision == "accept_manual":
            self._mark_time_review(
                entry,
                status_value="manually_approved",
                method="accept_manual",
                current_user=current_user,
            )
        elif decision == "accept_gps":
            if final_work_minutes is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "GPS-Zeit fehlt fuer diese Entscheidung.")
            self._apply_final_work_minutes(entry, final_work_minutes)
            self._mark_time_review(
                entry,
                status_value="corrected",
                method="accept_gps",
                current_user=current_user,
            )
        elif decision == "corrected":
            if final_work_minutes is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Korrigierte Arbeitszeit fehlt.")
            self._apply_final_work_minutes(entry, final_work_minutes)
            self._mark_time_review(
                entry,
                status_value="corrected",
                method="manual_correction",
                current_user=current_user,
            )
        elif decision == "assign_site":
            if reviewed_site_id is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bitte eine Baustelle auswaehlen.")
            self._mark_time_review(
                entry,
                status_value="manually_approved",
                method="assign_site",
                current_user=current_user,
            )
        elif decision == "mark_not_verifiable":
            self._mark_time_review(
                entry,
                status_value="not_verifiable",
                method="mark_not_verifiable",
                current_user=current_user,
            )
        elif decision == "mark_clarification":
            entry.time_review_status = "clarification"
            entry.time_review_method = "clarification"
            entry.reviewed_by_user_id = current_user.id
            entry.reviewed_at = datetime.now().astimezone()
        else:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Review-Entscheidung ist nicht erlaubt.")

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

    def list_weekly_reviews(self, *, iso_year: int, iso_week: int | None = None, current_user: User) -> list[TimeEntryWeeklyReview]:
        self._ensure_can_review_time(current_user)
        if iso_week is not None:
            self._ensure_valid_iso_week(iso_year, iso_week)
        statement = select(TimeEntryWeeklyReview).where(TimeEntryWeeklyReview.iso_year == iso_year)
        if iso_week is not None:
            statement = statement.where(TimeEntryWeeklyReview.iso_week == iso_week)
        statement = statement.order_by(TimeEntryWeeklyReview.iso_week, TimeEntryWeeklyReview.person_id)
        return list(self.db.scalars(statement))

    def list_person_weekly_reviews(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int | None = None,
    ) -> list[TimeEntryWeeklyReview]:
        if iso_week is not None:
            self._ensure_valid_iso_week(iso_year, iso_week)
        statement = (
            select(TimeEntryWeeklyReview)
            .where(TimeEntryWeeklyReview.person_id == person_id)
            .where(TimeEntryWeeklyReview.iso_year == iso_year)
        )
        if iso_week is not None:
            statement = statement.where(TimeEntryWeeklyReview.iso_week == iso_week)
        statement = statement.order_by(TimeEntryWeeklyReview.iso_week)
        return list(self.db.scalars(statement))

    def mark_weekly_review(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int,
        current_user: User,
    ) -> TimeEntryWeeklyReview:
        self._ensure_can_review_time(current_user)
        self._ensure_person_exists(person_id)
        self._ensure_valid_iso_week(iso_year, iso_week)
        statement = (
            select(TimeEntryWeeklyReview)
            .where(TimeEntryWeeklyReview.person_id == person_id)
            .where(TimeEntryWeeklyReview.iso_year == iso_year)
            .where(TimeEntryWeeklyReview.iso_week == iso_week)
        )
        review = self.db.scalar(statement)
        now = datetime.now().astimezone()
        if review is None:
            review = TimeEntryWeeklyReview(
                person_id=person_id,
                iso_year=iso_year,
                iso_week=iso_week,
                status=WEEKLY_REVIEW_STATUS_REVIEWED,
                reviewed_by_user_id=current_user.id,
                reviewed_at=now,
            )
            self.db.add(review)
        else:
            review.status = WEEKLY_REVIEW_STATUS_REVIEWED
            review.reviewed_by_user_id = current_user.id
            review.reviewed_at = now
        if hasattr(self.db, "flush"):
            self.db.flush()
        PersonHoursAccountService(self.db).book_weekly_review_balance(
            review=review,
            current_user=current_user,
        )
        self.db.commit()
        self.db.refresh(review)
        return review

    def reset_weekly_review(
        self,
        *,
        person_id: int,
        iso_year: int,
        iso_week: int,
        current_user: User,
    ) -> TimeEntryWeeklyReview:
        self._ensure_can_review_time(current_user)
        self._ensure_person_exists(person_id)
        self._ensure_valid_iso_week(iso_year, iso_week)
        statement = (
            select(TimeEntryWeeklyReview)
            .where(TimeEntryWeeklyReview.person_id == person_id)
            .where(TimeEntryWeeklyReview.iso_year == iso_year)
            .where(TimeEntryWeeklyReview.iso_week == iso_week)
        )
        review = self.db.scalar(statement)
        if review is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Monteurwoche ist nicht geprüft.")
        if review.status != WEEKLY_REVIEW_STATUS_REVIEWED:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Monteurwoche ist nicht als geprüft markiert.")
        review.status = WEEKLY_REVIEW_STATUS_RESET
        self.db.commit()
        self.db.refresh(review)
        return review

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

    @staticmethod
    def is_project_mounting_time_relevant(entry: WorkTimeEntry, gps_evaluation: object | None = None) -> bool:
        if getattr(entry, "source", "manual") == "gps_suggestion":
            return False
        if getattr(entry, "site_id", None) is None:
            return False
        return TimeEntryService.project_mounting_work_minutes(entry) > 0

    @staticmethod
    def project_mounting_work_minutes(entry: WorkTimeEntry) -> int:
        payroll_minutes = getattr(entry, "payroll_corrected_work_minutes", None)
        if payroll_minutes is not None:
            return payroll_minutes
        payroll_duration = TimeEntryService._payroll_duration_minutes(
            getattr(entry, "payroll_corrected_start_time", None),
            getattr(entry, "payroll_corrected_end_time", None),
            getattr(entry, "payroll_corrected_break_minutes", None)
            if getattr(entry, "payroll_corrected_break_minutes", None) is not None
            else getattr(entry, "break_minutes", 0),
        )
        if payroll_duration is not None:
            return payroll_duration
        corrected_minutes = getattr(entry, "corrected_work_minutes", None)
        if corrected_minutes is not None:
            return corrected_minutes
        return getattr(entry, "work_minutes", 0) or 0

    def project_mounting_contexts(self, entries: list[WorkTimeEntry]) -> dict[int, dict[str, object]]:
        if not entries:
            return {}
        dated_site_entries = [
            entry
            for entry in entries
            if entry.id is not None and entry.site_id is not None
        ]
        if not dated_site_entries:
            return {}

        dates_by_site: dict[int, set[date]] = {}
        for entry in dated_site_entries:
            dates_by_site.setdefault(entry.site_id, set()).add(entry.work_date)
        site_ids = set(dates_by_site)
        start = min(entry.work_date for entry in dated_site_entries)
        end = max(entry.work_date for entry in dated_site_entries)

        assignments = list(
            self.db.scalars(
                select(Assignment)
                .options(selectinload(Assignment.person))
                .where(Assignment.site_id.in_(site_ids))
                .where(Assignment.start_date <= end)
                .where(Assignment.end_date >= start)
            ).all()
        )
        external_assignments = [
            assignment
            for assignment in assignments
            if assignment.person is not None
            and assignment.person.person_type in {PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP}
        ]
        absence_dates_by_person = self._active_absence_dates_by_person(
            {assignment.person_id for assignment in external_assignments},
            start=start,
            end=end,
        )

        external_people_by_site_date: dict[tuple[int, date], dict[int, str]] = {}
        for assignment in external_assignments:
            relevant_dates = dates_by_site.get(assignment.site_id, set())
            if not relevant_dates:
                continue
            cursor = max(assignment.start_date, start)
            last_day = min(assignment.end_date, end)
            while cursor <= last_day:
                if (
                    cursor in relevant_dates
                    and cursor not in absence_dates_by_person.get(assignment.person_id, set())
                ):
                    external_people_by_site_date.setdefault(
                        (assignment.site_id, cursor),
                        {},
                    )[assignment.person_id] = assignment.person.display_name
                cursor += timedelta(days=1)

        contexts: dict[int, dict[str, object]] = {}
        for entry in dated_site_entries:
            external_people = dict(external_people_by_site_date.get((entry.site_id, entry.work_date), {}))
            external_people.pop(entry.person_id, None)
            external_person_ids = sorted(external_people)
            participant_ids = [entry.person_id, *external_person_ids]
            participant_names = [
                entry.person.display_name if entry.person else f"Person {entry.person_id}",
                *(external_people[person_id] for person_id in external_person_ids),
            ]
            multiplier = max(1, len(participant_ids))
            base_work_minutes = TimeEntryService.project_mounting_work_minutes(entry)
            contexts[entry.id] = {
                "multiplier": multiplier,
                "external_person_count": len(external_person_ids),
                "participant_ids": participant_ids,
                "participant_names": participant_names,
                "base_work_minutes": base_work_minutes,
                "work_minutes": base_work_minutes * multiplier,
                "break_minutes": (entry.break_minutes or 0) * multiplier,
                "travel_minutes": (entry.travel_minutes or 0) * multiplier,
            }
        return contexts

    def _active_absence_dates_by_person(
        self,
        person_ids: set[int],
        *,
        start: date,
        end: date,
    ) -> dict[int, set[date]]:
        if not person_ids:
            return {}
        absences = list(
            self.db.scalars(
                select(Absence)
                .where(Absence.person_id.in_(person_ids))
                .where(Absence.status == AbsenceStatus.ACTIVE)
                .where(Absence.start_date <= end)
                .where(Absence.end_date >= start)
            ).all()
        )
        dates_by_person: dict[int, set[date]] = {}
        for absence in absences:
            cursor = max(absence.start_date, start)
            last_day = min(absence.end_date, end)
            while cursor <= last_day:
                dates_by_person.setdefault(absence.person_id, set()).add(cursor)
                cursor += timedelta(days=1)
        return dates_by_person

    @staticmethod
    def is_auto_plausible_time_entry(entry: WorkTimeEntry, gps_evaluation: object | None) -> bool:
        if gps_evaluation is None:
            return False
        gps_minutes = getattr(gps_evaluation, "work_minutes", None)
        if gps_minutes is None:
            return False
        review_notices = getattr(gps_evaluation, "review_notices", ())
        if review_notices:
            return False
        manual_minutes = getattr(entry, "work_minutes", None)
        if manual_minutes is None:
            return False
        return abs(gps_minutes - manual_minutes) <= GPS_TIME_REVIEW_TOLERANCE_MINUTES

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
    def _ensure_entry_can_be_deleted(entry: WorkTimeEntry) -> None:
        review_status = getattr(entry, "time_review_status", OPEN_TIME_REVIEW_STATUS) or OPEN_TIME_REVIEW_STATUS
        if (
            review_status != OPEN_TIME_REVIEW_STATUS
            or getattr(entry, "status", None) == "reviewed"
            or getattr(entry, "reviewed_by_user_id", None) is not None
            or getattr(entry, "reviewed_at", None) is not None
            or getattr(entry, "payroll_reviewed_by_user_id", None) is not None
            or getattr(entry, "payroll_reviewed_at", None) is not None
            or getattr(entry, "payroll_corrected_work_minutes", None) is not None
            or getattr(entry, "payroll_corrected_start_time", None) is not None
            or getattr(entry, "payroll_corrected_end_time", None) is not None
            or getattr(entry, "payroll_corrected_break_minutes", None) is not None
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Geprüfte Arbeitszeiten können nicht gelöscht werden.")

    @staticmethod
    def _ensure_valid_iso_week(iso_year: int, iso_week: int) -> None:
        if iso_year < 2000 or iso_year > 2100 or iso_week < 1 or iso_week > 53:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kalenderwoche ist ungueltig.")

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

    @staticmethod
    def _apply_final_work_minutes(entry: WorkTimeEntry, final_work_minutes: int) -> None:
        if final_work_minutes < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Gepruefte Arbeitszeit darf nicht negativ sein.")
        if entry.original_work_minutes is None:
            entry.original_work_minutes = entry.work_minutes
        entry.corrected_work_minutes = final_work_minutes
        entry.work_minutes = final_work_minutes

    @staticmethod
    def payroll_review_state(entry: WorkTimeEntry, *, gps_work_minutes: int | None, review_notices: list[str]) -> dict:
        review_status = getattr(entry, "time_review_status", OPEN_TIME_REVIEW_STATUS) or OPEN_TIME_REVIEW_STATUS
        is_auto_plausible = (
            review_status == OPEN_TIME_REVIEW_STATUS
            and getattr(entry, "source", "manual") != "gps_suggestion"
            and not review_notices
            and gps_work_minutes is not None
            and abs(gps_work_minutes - entry.work_minutes) <= GPS_TIME_REVIEW_TOLERANCE_MINUTES
        )
        if is_auto_plausible:
            state = "auto_plausible"
        elif review_status != OPEN_TIME_REVIEW_STATUS:
            state = "checked"
        else:
            state = "open"
        return {
            "state": state,
            "is_auto_plausible": is_auto_plausible,
        }

    def _ensure_person_exists(self, person_id: int) -> None:
        if self.db.get(Person, person_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Person nicht gefunden.")

    def _ensure_week_is_open(self, person_id: int, work_date: date) -> None:
        iso_year, iso_week, _ = work_date.isocalendar()
        review = self.db.scalar(
            select(TimeEntryWeeklyReview)
            .where(TimeEntryWeeklyReview.person_id == person_id)
            .where(TimeEntryWeeklyReview.iso_year == iso_year)
            .where(TimeEntryWeeklyReview.iso_week == iso_week)
            .where(TimeEntryWeeklyReview.status == WEEKLY_REVIEW_STATUS_REVIEWED)
        )
        if review is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Geprüfte Woche zuerst zurücksetzen.",
            )

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

    @staticmethod
    def _duration_minutes(
        start_time: time | None,
        end_time: time | None,
        break_minutes: int,
    ) -> int | None:
        if start_time is None or end_time is None:
            return None
        start_minutes = start_time.hour * 60 + start_time.minute
        end_minutes = end_time.hour * 60 + end_time.minute
        if end_minutes <= start_minutes:
            return None
        return max(0, end_minutes - start_minutes - (break_minutes or 0))

    @staticmethod
    def _payroll_duration_minutes(
        start_time: time | None,
        end_time: time | None,
        break_minutes: int,
    ) -> int | None:
        if start_time is None or end_time is None or start_time == end_time:
            return None
        start_minutes = start_time.hour * 60 + start_time.minute
        end_minutes = end_time.hour * 60 + end_time.minute
        gross_minutes = end_minutes - start_minutes
        if gross_minutes < 0:
            gross_minutes += 24 * 60
        net_minutes = gross_minutes - (break_minutes or 0)
        return net_minutes if net_minutes > 0 else None

    def _ensure_no_time_overlap(
        self,
        *,
        person_id: int,
        work_date: date,
        start_time: time | None,
        end_time: time | None,
        exclude_entry_id: int | None = None,
    ) -> None:
        if start_time is None or end_time is None:
            return
        statement = (
            select(WorkTimeEntry)
            .options(selectinload(WorkTimeEntry.site))
            .where(WorkTimeEntry.person_id == person_id)
            .where(WorkTimeEntry.work_date == work_date)
        )
        if exclude_entry_id is not None:
            statement = statement.where(WorkTimeEntry.id != exclude_entry_id)
        conflicts = [
            entry
            for entry in self.db.scalars(statement)
            if self._time_ranges_overlap(start_time, end_time, entry.start_time, entry.end_time)
        ]
        if not conflicts:
            return
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "time_entry_overlap",
                "message": "Der neue Eintrag überschneidet sich mit einem vorhandenen Zeiteintrag.",
                "conflicts": [self._time_overlap_conflict_detail(entry) for entry in conflicts],
            },
        )

    @staticmethod
    def _time_ranges_overlap(
        start_time: time,
        end_time: time,
        existing_start_time: time | None,
        existing_end_time: time | None,
    ) -> bool:
        if existing_start_time is None or existing_end_time is None:
            return False
        return start_time < existing_end_time and end_time > existing_start_time

    @staticmethod
    def _time_overlap_conflict_detail(entry: WorkTimeEntry) -> dict[str, object]:
        site_label = "Ohne Baustelle"
        if entry.site is not None:
            site_label = " - ".join(part for part in [entry.site.site_number, entry.site.name] if part)
        return {
            "id": entry.id,
            "site_id": entry.site_id,
            "site_label": site_label,
            "start_time": entry.start_time.strftime("%H:%M") if entry.start_time else None,
            "end_time": entry.end_time.strftime("%H:%M") if entry.end_time else None,
        }


def clean_optional_text(value: str | None) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
