from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.work_time_entry import WorkTimeEntry
from app.services.pdf_export_service import SimplePdf

GERMAN_WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


@dataclass(frozen=True)
class WeeklyHoursRow:
    work_date: date
    site_name: str
    site_number: str
    reported_minutes: int | None
    note: str


class TimeEntryWeeklyPdfService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def weekly_worker_hours(self, *, week_start: date) -> bytes:
        start = week_start - timedelta(days=week_start.weekday())
        end = start + timedelta(days=6)
        people = self._active_internal_people()
        rows_by_person_id = self._weekly_rows_by_person(start=start, end=end)

        pdf = SimplePdf()
        for person in people:
            pdf.add_page()
            self._render_person_page(
                pdf=pdf,
                person=person,
                rows=rows_by_person_id.get(person.id, []),
                start=start,
                end=end,
            )

        if not people:
            pdf.add_heading("Arbeitsstunden", "Keine aktiven internen Monteure gefunden.")
        return pdf.render()

    def _active_internal_people(self) -> list[Person]:
        statement = (
            select(Person)
            .options(selectinload(Person.users))
            .where(Person.is_active.is_(True))
            .where(Person.deleted_at.is_(None))
            .where(Person.person_type == PersonType.INTERNAL)
            .order_by(Person.display_name)
        )
        return [person for person in self.db.scalars(statement) if is_payroll_worker_person(person)]

    def _weekly_rows_by_person(self, *, start: date, end: date) -> dict[int, list[WeeklyHoursRow]]:
        statement = (
            select(WorkTimeEntry)
            .options(selectinload(WorkTimeEntry.person), selectinload(WorkTimeEntry.site))
            .where(WorkTimeEntry.work_date >= start)
            .where(WorkTimeEntry.work_date <= end)
            .where(WorkTimeEntry.source != "gps_suggestion")
            .order_by(WorkTimeEntry.person_id, WorkTimeEntry.work_date, WorkTimeEntry.id)
        )
        rows_by_person_id: dict[int, list[WeeklyHoursRow]] = defaultdict(list)
        for entry in self.db.scalars(statement):
            rows_by_person_id[entry.person_id].append(
                WeeklyHoursRow(
                    work_date=entry.work_date,
                    site_name=entry.site.name if entry.site else "-",
                    site_number=entry.site.site_number if entry.site and entry.site.site_number else "",
                    reported_minutes=(
                        entry.original_work_minutes
                        if entry.original_work_minutes is not None
                        else entry.work_minutes
                    ),
                    note=entry.note or "",
                )
            )
        return rows_by_person_id

    def _render_person_page(
        self,
        *,
        pdf: SimplePdf,
        person: Person,
        rows: list[WeeklyHoursRow],
        start: date,
        end: date,
    ) -> None:
        week_number = start.isocalendar().week
        pdf.add_heading(
            f"Arbeitsstunden KW {week_number:02d}",
            f"{person.display_name} | {format_short_date(start)} bis {format_short_date(end)}",
        )
        if not rows:
            pdf.text("Keine eingetragenen Arbeitsstunden in dieser Kalenderwoche.")
            return

        pdf.text(format_table_header(), size=8, bold=True)
        pdf.text("-" * 95, size=8)
        total_minutes = 0
        for row in rows:
            total_minutes += row.reported_minutes or 0
            pdf.text(format_table_row(row), size=8)
        pdf.space(8)
        pdf.text(f"Summe eingetragene Arbeitszeit: {format_hours(total_minutes)}", bold=True)


def format_table_header() -> str:
    return fixed_row(["Tag", "Datum", "Baustelle", "Nr.", "Zeit", "Notiz"], [4, 9, 25, 10, 8, 28])


def format_table_row(row: WeeklyHoursRow) -> str:
    return fixed_row(
        [
            GERMAN_WEEKDAYS[row.work_date.weekday()],
            row.work_date.strftime("%d.%m.%y"),
            row.site_name,
            row.site_number,
            format_hours(row.reported_minutes),
            row.note,
        ],
        [4, 9, 25, 10, 8, 28],
    )


def fixed_row(values: list[str], widths: list[int]) -> str:
    return "  ".join(clean_cell(value, width).ljust(width) for value, width in zip(values, widths, strict=True))


def clean_cell(value: str, width: int) -> str:
    cleaned = " ".join(str(value).split())
    if len(cleaned) <= width:
        return cleaned
    return f"{cleaned[:max(0, width - 1)]}."


def format_hours(minutes: int | None) -> str:
    if minutes is None:
        return ""
    value = f"{minutes / 60:.2f}".rstrip("0").rstrip(".")
    if "," not in value and "." not in value:
        value = f"{value}.0"
    return f"{value.replace('.', ',')} h"


def format_short_date(value: date) -> str:
    return value.strftime("%d.%m.%y")


def is_payroll_worker_person(person: Person) -> bool:
    if not person.is_active or person.deleted_at is not None or person.person_type != PersonType.INTERNAL:
        return False
    active_roles = {user.role for user in person.users if user.is_active}
    if not active_roles:
        return True
    return active_roles == {UserRole.MONTEUR}
