from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.work_time_entry import WorkTimeEntry


WEEKLY_REVIEW_STATUS_REVIEWED = "reviewed"
WEEKLY_REVIEW_STATUS_RESET = "reset"

PayrollWeekKey = tuple[int, int, int]


@dataclass(frozen=True)
class PayrollReviewRange:
    person_id: int
    start_date: date
    end_date: date


@dataclass(frozen=True)
class PayrollReviewInvalidation:
    reset_week_keys: frozenset[PayrollWeekKey]


class PayrollReviewInvalidationService:
    """Invalidate approvals whose payroll source data changed.

    The service deliberately changes review state only. Historical account
    references and postings remain untouched.
    """

    def __init__(self, db: Session) -> None:
        self.db = db

    def invalidate(
        self,
        *affected_ranges: PayrollReviewRange,
        clear_row_reviews: bool = False,
    ) -> PayrollReviewInvalidation:
        if not hasattr(self.db, "scalars"):
            return PayrollReviewInvalidation(reset_week_keys=frozenset())
        ranges = tuple(self._validated_ranges(affected_ranges))
        if not ranges:
            return PayrollReviewInvalidation(reset_week_keys=frozenset())

        reset_week_keys = self._reset_weekly_reviews(ranges)
        if clear_row_reviews:
            self._clear_row_reviews(ranges)
        return PayrollReviewInvalidation(reset_week_keys=frozenset(reset_week_keys))

    def _reset_weekly_reviews(
        self,
        affected_ranges: tuple[PayrollReviewRange, ...],
    ) -> set[PayrollWeekKey]:
        affected_keys = {
            week_key
            for affected_range in affected_ranges
            for week_key in self._week_keys(affected_range)
        }
        if not affected_keys:
            return set()
        person_ids = {person_id for person_id, _iso_year, _iso_week in affected_keys}
        iso_years = {iso_year for _person_id, iso_year, _iso_week in affected_keys}
        reviews = self.db.scalars(
            select(TimeEntryWeeklyReview).where(
                TimeEntryWeeklyReview.person_id.in_(person_ids),
                TimeEntryWeeklyReview.iso_year.in_(iso_years),
                TimeEntryWeeklyReview.status == WEEKLY_REVIEW_STATUS_REVIEWED,
            )
        )
        reset_keys: set[PayrollWeekKey] = set()
        for review in reviews:
            key = (review.person_id, review.iso_year, review.iso_week)
            if key not in affected_keys:
                continue
            review.status = WEEKLY_REVIEW_STATUS_RESET
            reset_keys.add(key)
        return reset_keys

    def _clear_row_reviews(
        self,
        affected_ranges: tuple[PayrollReviewRange, ...],
    ) -> None:
        clauses = [
            (
                (WorkTimeEntry.person_id == affected_range.person_id)
                & (WorkTimeEntry.work_date >= affected_range.start_date)
                & (WorkTimeEntry.work_date <= affected_range.end_date)
            )
            for affected_range in affected_ranges
        ]
        entries = self.db.scalars(select(WorkTimeEntry).where(or_(*clauses)))
        for entry in entries:
            entry.payroll_reviewed_by_user_id = None
            entry.payroll_reviewed_at = None

    @staticmethod
    def _validated_ranges(
        affected_ranges: tuple[PayrollReviewRange, ...],
    ) -> list[PayrollReviewRange]:
        ranges: list[PayrollReviewRange] = []
        for affected_range in affected_ranges:
            if affected_range.end_date < affected_range.start_date:
                raise ValueError("Payroll review range ends before it starts.")
            if affected_range not in ranges:
                ranges.append(affected_range)
        return ranges

    @staticmethod
    def _week_keys(affected_range: PayrollReviewRange) -> set[PayrollWeekKey]:
        keys: set[PayrollWeekKey] = set()
        cursor = affected_range.start_date - timedelta(days=affected_range.start_date.weekday())
        while cursor <= affected_range.end_date:
            iso_year, iso_week, _iso_weekday = cursor.isocalendar()
            keys.add((affected_range.person_id, iso_year, iso_week))
            cursor += timedelta(days=7)
        return keys
