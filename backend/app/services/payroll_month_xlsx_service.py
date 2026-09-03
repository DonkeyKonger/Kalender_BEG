from __future__ import annotations

import calendar
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Collection, Iterable, Sequence
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import date, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape, quoteattr

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, OvernightStatus
from app.models.person import Person
from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.services.absence_service import absence_weekdays
from app.services.person_hours_account_service import (
    OFFICE_ONLY_TIME_ENTRY_NOTE,
    effective_corrected_work_minutes,
    effective_weekly_work_minutes,
)
from app.services.payroll_xlsx_template import load_payroll_monthly_template
from app.services.time_entry_rounding import round_minutes_to_quarter_hour


SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SHEET_NAMESPACES = {
    "": SPREADSHEET_NS,
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "x14ac": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac",
    "x16r2": "http://schemas.microsoft.com/office/spreadsheetml/2015/02/main",
    "xr": "http://schemas.microsoft.com/office/spreadsheetml/2014/revision",
    "xr2": "http://schemas.microsoft.com/office/spreadsheetml/2015/revision2",
    "xr3": "http://schemas.microsoft.com/office/spreadsheetml/2016/revision3",
}
for prefix, uri in SHEET_NAMESPACES.items():
    ET.register_namespace(prefix, uri)

FOUR_DAY_MINIMUM_WEEK_MINUTES = 36 * 60
DISTRIBUTED_WORK_DAYS = 5
DISTRIBUTED_DAILY_BREAK_MINUTES = 45
VACATION_DAY_MINUTES = 8 * 60
SICK_DAY_HOURS = 8
GERMAN_MONTH_NAMES = (
    "",
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
)
MANUAL_SITE_NOTE_PREFIX = re.compile(r"^Manuelle Baustelle:\s*", re.IGNORECASE)
POSTAL_CITY_PATTERN = re.compile(r"\b\d{5}\s+([^,;]+)")


@dataclass(frozen=True)
class PayrollMonthTemplateLayout:
    worksheet_path: str = "xl/worksheets/sheet1.xml"
    styles_path: str = "xl/styles.xml"
    person_name_cell: str = "C2"
    month_label_cell: str = "C4"
    total_hours_cell: str = "E41"
    normal_hours_cell: str = "D46"
    overtime_hours_cell: str = "D47"
    sick_days_cell: str = "D48"
    sick_hours_cell: str = "G48"
    first_day_row: int = 10
    last_day_row: int = 40
    day_column: str = "A"
    start_column: str = "B"
    end_column: str = "C"
    break_column: str = "D"
    net_work_column: str = "E"
    overnight_column: str = "F"
    commission_column: str = "G"
    address_column: str = "H"


PAYROLL_MONTH_TEMPLATE_LAYOUT = PayrollMonthTemplateLayout()


@dataclass(frozen=True)
class PayrollMonthDay:
    work_date: date
    start_time: time | None
    end_time: time | None
    break_minutes: int
    net_work_minutes: int
    commission_number: str | None
    cost_center: str | None
    site_name: str | None
    site_address: str | None
    site_place: str | None
    overnight_status: OvernightStatus | None
    is_derived: bool
    source_entry_ids: tuple[int, ...]
    absence_type: AbsenceType | None = None


@dataclass(frozen=True)
class PayrollWeekOvertimeRemainder:
    iso_year: int
    iso_week: int
    minutes: int


@dataclass(frozen=True)
class PayrollMonthPlan:
    days: tuple[PayrollMonthDay, ...]
    overtime_remainders: tuple[PayrollWeekOvertimeRemainder, ...]


@dataclass(frozen=True)
class PayrollMonthWorkbook:
    content: bytes
    plan: PayrollMonthPlan


@dataclass(frozen=True)
class PayrollMonthSheet:
    person: Person
    sheet_name: str
    year: int
    month: int
    entries: Sequence[WorkTimeEntry]
    absences: Sequence[Absence] = ()
    non_working_dates: Collection[date] = ()


@dataclass(frozen=True)
class PayrollMonthsWorkbook:
    content: bytes
    plans: tuple[PayrollMonthPlan, ...]


@dataclass
class _DominantSiteCandidate:
    site: Site | None
    manual_place: str | None = None
    duration_minutes: int = 0
    latest_entry_order: tuple[int, int, int] = (-1, -1, -1)


def build_payroll_month_xlsx(
    *,
    person: Person,
    year: int,
    month: int,
    entries: Sequence[WorkTimeEntry],
    absences: Sequence[Absence] = (),
    non_working_dates: Collection[date] = (),
) -> PayrollMonthWorkbook:
    """Erstellt eine neue Monatsdatei, ohne Vorlage oder Quelldaten zu verändern."""
    template = load_payroll_monthly_template()
    output = BytesIO()
    with ZipFile(template, "r") as source, ZipFile(output, "w", ZIP_DEFLATED) as archive:
        sheet_root = ET.fromstring(source.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
        styles_root = ET.fromstring(source.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path))
        address_style_mapping = _append_shrink_to_fit_styles(
            styles_root,
            _address_cell_style_ids(sheet_root),
        )
        _apply_address_cell_styles(sheet_root, address_style_mapping)
        duration_style_mapping = _append_duration_styles(styles_root, sheet_root)
        _apply_duration_cell_styles(sheet_root, duration_style_mapping)
        plan = fill_payroll_month_sheet(
            sheet_root,
            person=person,
            year=year,
            month=month,
            entries=entries,
            absences=absences,
            non_working_dates=non_working_dates,
        )
        filled_sheet = ET.tostring(
            sheet_root,
            encoding="UTF-8",
            xml_declaration=True,
        )
        filled_sheet = _preserve_ignorable_namespaces(filled_sheet)
        filled_styles = _preserve_ignorable_namespaces(
            ET.tostring(styles_root, encoding="UTF-8", xml_declaration=True)
        )
        for item in source.infolist():
            if item.filename == PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path:
                content = filled_sheet
            elif item.filename == PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path:
                content = filled_styles
            else:
                content = source.read(item.filename)
            archive.writestr(item, content)
    return PayrollMonthWorkbook(content=output.getvalue(), plan=plan)


def build_payroll_months_xlsx(sheets: Sequence[PayrollMonthSheet]) -> PayrollMonthsWorkbook:
    """Erstellt eine Datei mit einer frischen Kopie der Mastervorlage je Monteur."""
    if not sheets:
        raise ValueError("Mindestens ein Monatsblatt ist erforderlich.")

    template = load_payroll_monthly_template()
    output = BytesIO()
    plans: list[PayrollMonthPlan] = []
    with ZipFile(template, "r") as source, ZipFile(output, "w", ZIP_DEFLATED) as archive:
        template_sheet = source.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path)
        styles_root = ET.fromstring(source.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path))
        address_style_mapping = _append_shrink_to_fit_styles(
            styles_root,
            _address_cell_style_ids(ET.fromstring(template_sheet)),
        )
        duration_style_mapping = _append_duration_styles(
            styles_root, ET.fromstring(template_sheet)
        )
        template_sheet_relationships = source.read("xl/worksheets/_rels/sheet1.xml.rels")
        template_drawing = source.read("xl/drawings/drawing1.xml")
        template_drawing_relationships = source.read("xl/drawings/_rels/drawing1.xml.rels")
        generated_parts = {
            "[Content_Types].xml",
            "docProps/app.xml",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
            PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path,
            "xl/worksheets/_rels/sheet1.xml.rels",
            "xl/drawings/drawing1.xml",
            "xl/drawings/_rels/drawing1.xml.rels",
        }
        for item in source.infolist():
            if item.filename not in generated_parts:
                archive.writestr(item, source.read(item.filename))

        sheet_names = unique_payroll_month_sheet_names(sheet.sheet_name for sheet in sheets)
        archive.writestr(
            "[Content_Types].xml",
            _payroll_month_content_types(source.read("[Content_Types].xml"), len(sheets)),
        )
        archive.writestr(
            "docProps/app.xml",
            _payroll_month_app_properties(source.read("docProps/app.xml"), sheet_names),
        )
        archive.writestr(
            "xl/workbook.xml",
            _payroll_month_workbook_xml(source.read("xl/workbook.xml"), sheet_names),
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            _payroll_month_workbook_relationships(
                source.read("xl/_rels/workbook.xml.rels"), len(sheets)
            ),
        )
        archive.writestr(
            PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path,
            _preserve_ignorable_namespaces(
                ET.tostring(styles_root, encoding="UTF-8", xml_declaration=True)
            ),
        )

        for index, sheet in enumerate(sheets, start=1):
            sheet_root = ET.fromstring(template_sheet)
            _apply_address_cell_styles(sheet_root, address_style_mapping)
            _apply_duration_cell_styles(sheet_root, duration_style_mapping)
            plans.append(
                fill_payroll_month_sheet(
                    sheet_root,
                    person=sheet.person,
                    year=sheet.year,
                    month=sheet.month,
                    entries=sheet.entries,
                    absences=sheet.absences,
                    non_working_dates=sheet.non_working_dates,
                )
            )
            filled_sheet = _preserve_ignorable_namespaces(
                ET.tostring(sheet_root, encoding="UTF-8", xml_declaration=True)
            )
            archive.writestr(f"xl/worksheets/sheet{index}.xml", filled_sheet)
            archive.writestr(
                f"xl/worksheets/_rels/sheet{index}.xml.rels",
                _payroll_month_sheet_relationships(template_sheet_relationships, index),
            )
            archive.writestr(f"xl/drawings/drawing{index}.xml", template_drawing)
            archive.writestr(
                f"xl/drawings/_rels/drawing{index}.xml.rels",
                template_drawing_relationships,
            )

    return PayrollMonthsWorkbook(content=output.getvalue(), plans=tuple(plans))


def fill_payroll_month_sheet(
    sheet: ET.Element,
    *,
    person: Person,
    year: int,
    month: int,
    entries: Sequence[WorkTimeEntry],
    absences: Sequence[Absence] = (),
    non_working_dates: Collection[date] = (),
) -> PayrollMonthPlan:
    """Befüllt genau ein Monatsblatt mit den freigegebenen Tagesfeldern."""
    plan = build_payroll_month_plan(
        person=person,
        year=year,
        month=month,
        entries=entries,
        absences=absences,
        non_working_dates=non_working_dates,
    )
    _write_month_header(sheet, person=person, year=year, month=month)
    _clear_month_day_values(sheet, year=year, month=month)
    for day in plan.days:
        _write_month_day(sheet, day)
    _write_month_totals(
        sheet,
        person=person,
        plan=plan,
        year=year,
        month=month,
        non_working_dates=non_working_dates,
    )
    return plan


def build_payroll_month_plan(
    *,
    person: Person,
    year: int,
    month: int,
    entries: Sequence[WorkTimeEntry],
    absences: Sequence[Absence] = (),
    non_working_dates: Collection[date] = (),
) -> PayrollMonthPlan:
    if month < 1 or month > 12:
        raise ValueError("month muss zwischen 1 und 12 liegen.")
    person_entries = [
        entry for entry in entries if entry.person_id == person.id and _is_valid_time_entry(entry)
    ]
    entries_by_date: dict[date, list[WorkTimeEntry]] = defaultdict(list)
    for entry in person_entries:
        entries_by_date[entry.work_date].append(entry)

    days_by_date = {
        work_date: _build_actual_payroll_day(work_date, day_entries)
        for work_date, day_entries in entries_by_date.items()
    }
    days_by_date = {
        work_date: day
        for work_date, day in days_by_date.items()
        if day is not None and day.net_work_minutes > 0
    }
    absence_dates = _active_absence_dates(person, absences)
    blocked_dates = absence_dates.union(non_working_dates)
    for week_start in _month_week_starts(year, month):
        weekdays = [week_start + timedelta(days=offset) for offset in range(5)]
        # Eine Verteilung über Monatsgrenzen würde Stunden aus dem gewählten
        # Abrechnungsmonat heraus- oder hineinverschieben.
        if any(day.year != year or day.month != month for day in weekdays):
            continue
        actual_days = [
            days_by_date[work_date] for work_date in weekdays if work_date in days_by_date
        ]
        missing_dates = [work_date for work_date in weekdays if work_date not in days_by_date]
        actual_week_minutes = sum(day.net_work_minutes for day in actual_days)
        if (
            len(actual_days) != 4
            or len(missing_dates) != 1
            or actual_week_minutes < FOUR_DAY_MINIMUM_WEEK_MINUTES
            or missing_dates[0] in blocked_dates
        ):
            continue

        actual_days.sort(key=lambda day: day.work_date)
        base_daily_minutes, remainder_minutes = divmod(
            actual_week_minutes,
            DISTRIBUTED_WORK_DAYS,
        )
        distributed_minutes = {
            work_date: base_daily_minutes + (index < remainder_minutes)
            for index, work_date in enumerate(weekdays)
        }
        for day in actual_days:
            days_by_date[day.work_date] = _distributed_actual_day(
                day,
                net_work_minutes=distributed_minutes[day.work_date],
            )

        last_actual_day = actual_days[-1]
        missing_date = missing_dates[0]
        derived_start = last_actual_day.start_time
        derived_net_work_minutes = distributed_minutes[missing_date]
        days_by_date[missing_date] = PayrollMonthDay(
            work_date=missing_date,
            start_time=derived_start,
            end_time=_clock_from_minutes(
                _clock_minutes(derived_start)
                + derived_net_work_minutes
                + DISTRIBUTED_DAILY_BREAK_MINUTES
            ) if derived_start is not None else None,
            break_minutes=DISTRIBUTED_DAILY_BREAK_MINUTES,
            net_work_minutes=derived_net_work_minutes,
            commission_number=last_actual_day.commission_number,
            cost_center=last_actual_day.cost_center,
            site_name=last_actual_day.site_name,
            site_address=last_actual_day.site_address,
            site_place=last_actual_day.site_place,
            overnight_status=None,
            is_derived=True,
            source_entry_ids=(),
        )

    # Abwesenheitsgutschriften sind keine geleisteten Stunden und dürfen nicht
    # in die Vier-auf-fünf-Tage-Verteilung einfließen.
    credited_absence_minutes = 0
    for work_date, absence_type in _payroll_absences_by_date(
        person, absences, year=year, month=month, non_working_dates=non_working_dates
    ).items():
        if work_date in days_by_date:
            continue
        absence_day = _build_absence_payroll_day(work_date, absence_type)
        days_by_date[work_date] = absence_day
        credited_absence_minutes += absence_day.net_work_minutes

    month_days = tuple(
        day
        for work_date, day in sorted(days_by_date.items())
        if work_date.year == year and work_date.month == month
    )
    source_month_minutes = sum(
        _entry_work_minutes(entry)
        for entry in person_entries
        if entry.work_date.year == year and entry.work_date.month == month
    )
    if sum(day.net_work_minutes for day in month_days) != (
        source_month_minutes + credited_absence_minutes
    ):
        raise ValueError(
            "Die Excel-Stundensumme weicht von den erfassten Monatsstunden "
            "zuzüglich Abwesenheitsgutschriften ab."
        )
    return PayrollMonthPlan(
        days=month_days,
        overtime_remainders=(),
    )


def _build_actual_payroll_day(
    work_date: date,
    entries: Sequence[WorkTimeEntry],
) -> PayrollMonthDay | None:
    net_work_minutes = sum(_entry_work_minutes(entry) for entry in entries)
    if net_work_minutes <= 0:
        return None
    intervals = [_entry_interval(entry) for entry in entries]
    valid_intervals = [interval for interval in intervals if interval is not None]
    # Uhrzeiten beschreiben den Tagesrahmen. Die abzurechnenden Minuten kommen
    # wie in der Lohnprüfung aus den einzelnen Buchungen, nicht aus diesem Rahmen.
    rounded_start = round_minutes_to_quarter_hour(
        min(interval[0] for interval in valid_intervals)
    ) if valid_intervals else None
    rounded_end = round_minutes_to_quarter_hour(
        max(interval[1] for interval in valid_intervals)
    ) if valid_intervals else None
    break_minutes = sum(_entry_break_minutes(entry) for entry in entries)
    dominant_site = _dominant_site(entries)
    site = dominant_site.site
    return PayrollMonthDay(
        work_date=work_date,
        start_time=_clock_from_minutes(rounded_start) if rounded_start is not None else None,
        end_time=_clock_from_minutes(rounded_end) if rounded_end is not None else None,
        break_minutes=break_minutes,
        net_work_minutes=net_work_minutes,
        commission_number=_clean_text(getattr(site, "site_number", None)),
        cost_center=None,
        site_name=_clean_text(getattr(site, "name", None)),
        site_address=_site_address(site),
        site_place=_site_place(site) or dominant_site.manual_place,
        overnight_status=_day_overnight_status(entries),
        is_derived=False,
        source_entry_ids=tuple(sorted(entry.id for entry in entries if entry.id is not None)),
    )


def _dominant_site(entries: Sequence[WorkTimeEntry]) -> _DominantSiteCandidate:
    candidates: dict[tuple[object, ...], _DominantSiteCandidate] = {}
    for entry in entries:
        interval = _entry_interval(entry)
        start_minutes, end_minutes = interval or (-1, -1)
        duration_minutes = max(
            0,
            end_minutes - start_minutes - _entry_break_minutes(entry),
        ) if interval is not None else _entry_work_minutes(entry)
        site = _entry_site(entry)
        manual_place = _manual_site_place(entry) if site is None else None
        key = _site_group_key(entry, site, manual_place)
        candidate = candidates.setdefault(
            key,
            _DominantSiteCandidate(site=site, manual_place=manual_place),
        )
        candidate.duration_minutes += duration_minutes
        entry_order = (start_minutes, end_minutes, entry.id or -1)
        if entry_order > candidate.latest_entry_order:
            candidate.latest_entry_order = entry_order
            candidate.site = site
            candidate.manual_place = manual_place
    return max(
        candidates.values(),
        key=lambda candidate: (
            candidate.site is not None,
            candidate.duration_minutes,
            candidate.latest_entry_order,
        ),
    )


def _site_group_key(
    entry: WorkTimeEntry,
    site: Site | None,
    manual_place: str | None,
) -> tuple[object, ...]:
    if site is None:
        if manual_place:
            return ("manual", manual_place.casefold())
        return ("missing", entry.site_id, entry.original_site_id, entry.assignment_id)
    if site.id is not None:
        return ("site-id", site.id)
    return (
        "site-values",
        _clean_text(site.site_number),
        _clean_text(site.name),
        _site_address(site),
    )


def _entry_site(entry: WorkTimeEntry) -> Site | None:
    direct_site = getattr(entry, "site", None)
    if direct_site is not None:
        return direct_site
    original_site = getattr(entry, "original_site", None)
    if original_site is not None:
        return original_site
    assignment = getattr(entry, "assignment", None)
    return getattr(assignment, "site", None)


def _manual_site_place(entry: WorkTimeEntry) -> str | None:
    note = _clean_text(entry.note)
    if note is None or note == OFFICE_ONLY_TIME_ENTRY_NOTE:
        return None
    if MANUAL_SITE_NOTE_PREFIX.match(note) is None:
        return None
    manual_value = _clean_text(MANUAL_SITE_NOTE_PREFIX.sub("", note, count=1))
    return _place_from_text(manual_value, allow_unstructured=True)


def _is_valid_time_entry(entry: WorkTimeEntry) -> bool:
    return entry.source != "gps_suggestion" and _entry_work_minutes(entry) > 0


def _entry_work_minutes(entry: WorkTimeEntry) -> int:
    # Gemeinsame Lohnlogik: Korrektur vor Meldung, Fahrtzeit hinzurechnen und
    # je Buchung runden. Niemals den Tagesrahmen erneut als Arbeitszeit werten.
    # Bei alten Korrekturen ohne gespeicherte Minutensumme behandelt die UI
    # einen vollständig durch Pause belegten Zeitraum als null, nicht als Fallback.
    if (
        entry.payroll_corrected_work_minutes is None
        and entry.payroll_corrected_start_time is not None
        and entry.payroll_corrected_end_time is not None
        and entry.payroll_corrected_start_time != entry.payroll_corrected_end_time
        and effective_corrected_work_minutes(entry) is None
    ):
        return round_minutes_to_quarter_hour(entry.travel_minutes or 0)
    return effective_weekly_work_minutes(entry)


def _entry_interval(entry: WorkTimeEntry) -> tuple[int, int] | None:
    start = entry.payroll_corrected_start_time or entry.start_time
    end = entry.payroll_corrected_end_time or entry.end_time
    if start is None or end is None or start == end:
        return None
    start_minutes = _clock_minutes(start)
    end_minutes = _clock_minutes(end)
    if end_minutes <= start_minutes:
        end_minutes += 24 * 60
    return start_minutes, end_minutes


def _entry_break_minutes(entry: WorkTimeEntry) -> int:
    corrected = entry.payroll_corrected_break_minutes
    return max(0, corrected if corrected is not None else entry.break_minutes or 0)


def _day_overnight_status(entries: Sequence[WorkTimeEntry]) -> OvernightStatus | None:
    for entry in sorted(
        entries,
        key=lambda item: (_entry_interval(item) or (-1, -1), item.id or -1),
    ):
        work_day = getattr(entry, "work_day", None)
        status_value = getattr(work_day, "overnight_status", None)
        if status_value is not None:
            return OvernightStatus(status_value)
    return None


def _active_absence_dates(
    person: Person,
    absences: Sequence[Absence],
) -> set[date]:
    result: set[date] = set()
    for absence in absences:
        if absence.person_id != person.id or absence.status != AbsenceStatus.ACTIVE:
            continue
        cursor = absence.start_date
        while cursor <= absence.end_date:
            result.add(cursor)
            cursor += timedelta(days=1)
    return result


def _payroll_absences_by_date(
    person: Person,
    absences: Sequence[Absence],
    *,
    year: int,
    month: int,
    non_working_dates: Collection[date],
) -> dict[date, AbsenceType]:
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    result: dict[date, AbsenceType] = {}
    for absence in absences:
        if (
            absence.person_id != person.id
            or absence.status != AbsenceStatus.ACTIVE
            or absence.absence_type not in (AbsenceType.VACATION, AbsenceType.SICK)
        ):
            continue
        for work_date in absence_weekdays(
            max(first, absence.start_date), min(last, absence.end_date), year
        ):
            if work_date in non_working_dates:
                continue
            result[work_date] = absence.absence_type
    return result


def _build_absence_payroll_day(
    work_date: date, absence_type: AbsenceType
) -> PayrollMonthDay:
    return PayrollMonthDay(
        work_date=work_date,
        start_time=None,
        end_time=None,
        break_minutes=0,
        net_work_minutes=VACATION_DAY_MINUTES if absence_type == AbsenceType.VACATION else 0,
        commission_number=None,
        cost_center=None,
        site_name=None,
        site_address=None,
        site_place=None,
        overnight_status=None,
        is_derived=False,
        source_entry_ids=(),
        absence_type=absence_type,
    )


def _month_week_starts(year: int, month: int) -> list[date]:
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    cursor = first - timedelta(days=first.weekday())
    final_week_start = last - timedelta(days=last.weekday())
    result: list[date] = []
    while cursor <= final_week_start:
        result.append(cursor)
        cursor += timedelta(days=7)
    return result


def _distributed_actual_day(
    day: PayrollMonthDay,
    *,
    net_work_minutes: int,
) -> PayrollMonthDay:
    start_minutes = _clock_minutes(day.start_time) if day.start_time is not None else None
    return replace(
        day,
        end_time=_clock_from_minutes(
            start_minutes + net_work_minutes + DISTRIBUTED_DAILY_BREAK_MINUTES
        ) if start_minutes is not None else None,
        break_minutes=DISTRIBUTED_DAILY_BREAK_MINUTES,
        net_work_minutes=net_work_minutes,
    )


def _clear_month_day_values(sheet: ET.Element, *, year: int, month: int) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    valid_day_count = calendar.monthrange(year, month)[1]
    for row_number in range(layout.first_day_row, layout.last_day_row + 1):
        day_number = row_number - layout.first_day_row + 1
        if day_number <= valid_day_count:
            _set_cell_number(sheet, f"{layout.day_column}{row_number}", day_number)
        else:
            _clear_cell(sheet, f"{layout.day_column}{row_number}")
        for column in (
            layout.start_column,
            layout.end_column,
            layout.break_column,
            layout.net_work_column,
            layout.overnight_column,
            layout.commission_column,
            layout.address_column,
        ):
            _clear_cell(sheet, f"{column}{row_number}")


def _write_month_header(
    sheet: ET.Element,
    *,
    person: Person,
    year: int,
    month: int,
) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    _set_cell_string(sheet, layout.person_name_cell, person.display_name)
    _set_cell_string(sheet, layout.month_label_cell, f"{GERMAN_MONTH_NAMES[month]} {year % 100:02d}")


def _write_month_day(sheet: ET.Element, day: PayrollMonthDay) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    row_number = layout.first_day_row + day.work_date.day - 1
    if day.absence_type is not None:
        _set_cell_number(
            sheet, f"{layout.net_work_column}{row_number}", day.net_work_minutes / 1440
        )
        _set_cell_string(
            sheet,
            f"{layout.address_column}{row_number}",
            "Urlaub" if day.absence_type == AbsenceType.VACATION else "Krankheit",
        )
        return
    _set_cell_string(sheet, f"{layout.start_column}{row_number}", _format_clock(day.start_time))
    _set_cell_string(sheet, f"{layout.end_column}{row_number}", _format_clock(day.end_time))
    _set_cell_string(
        sheet,
        f"{layout.break_column}{row_number}",
        _format_duration(day.break_minutes),
    )
    _set_cell_number(
        sheet,
        f"{layout.net_work_column}{row_number}",
        day.net_work_minutes / 1440,
    )
    _set_cell_string(
        sheet,
        f"{layout.overnight_column}{row_number}",
        _overnight_label(day.overnight_status),
    )
    _set_cell_string(
        sheet,
        f"{layout.commission_column}{row_number}",
        day.commission_number or day.cost_center or "",
    )
    _set_cell_string(
        sheet,
        f"{layout.address_column}{row_number}",
        day.site_place or "",
    )


def _write_month_totals(
    sheet: ET.Element,
    *,
    person: Person,
    plan: PayrollMonthPlan,
    year: int,
    month: int,
    non_working_dates: Collection[date],
) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    total_minutes = sum(day.net_work_minutes for day in plan.days)
    _set_cell_formula(
        sheet,
        layout.total_hours_cell,
        f"SUM({layout.net_work_column}{layout.first_day_row}:"
        f"{layout.net_work_column}{layout.last_day_row})",
        total_minutes / 1440,
    )
    sick_day_count = sum(day.absence_type == AbsenceType.SICK for day in plan.days)
    sick_minutes = sick_day_count * SICK_DAY_HOURS * 60
    _set_cell_number(sheet, layout.sick_days_cell, sick_day_count)
    _set_cell_formula(
        sheet,
        layout.sick_hours_cell,
        f"{layout.sick_days_cell}*{SICK_DAY_HOURS}/24",
        sick_minutes / 1440,
    )
    weekly_hours = person.weekly_hours
    if weekly_hours is None:
        # Fehlende Stammdaten sind kein Soll von null Stunden.
        _set_cell_string(sheet, layout.normal_hours_cell, "–")
        _set_cell_string(sheet, layout.overtime_hours_cell, "–")
        return

    workday_count = sum(
        work_date.weekday() < 5 and work_date not in non_working_dates
        for day_number in range(1, calendar.monthrange(year, month)[1] + 1)
        for work_date in (date(year, month, day_number),)
    )
    weekly_hours_decimal = Decimal(str(weekly_hours))
    normal_minutes = int(
        (weekly_hours_decimal / 5 * workday_count * 60).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    ) - sick_minutes
    # Krankenstunden mindern nur das Soll, nicht die tatsächlich erfassten Stunden.
    _set_cell_formula(
        sheet,
        layout.normal_hours_cell,
        f"ROUND({weekly_hours_decimal}/5*{workday_count}*60,0)/1440-{layout.sick_hours_cell}",
        normal_minutes / 1440,
    )
    overtime_minutes = total_minutes - normal_minutes
    delta = f"ROUND(({layout.total_hours_cell}-{layout.normal_hours_cell})*1440,0)"
    # Excel im 1900-Datumssystem kann negative Zeitwerte nicht anzeigen.
    # Nur der negative Fall wird deshalb als formatierter Text ausgegeben.
    _set_cell_formula(
        sheet,
        layout.overtime_hours_cell,
        f'IF(ISNUMBER({layout.normal_hours_cell}),'
        f'IF({delta}<0,"-"&TEXT(ABS({delta})/1440,"[h]:mm"),{delta}/1440),"–")',
        (
            f"-{_format_duration(-overtime_minutes)}"
            if overtime_minutes < 0
            else overtime_minutes / 1440
        ),
    )


def _duration_cell_refs() -> list[str]:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    return [
        *(
            f"{layout.net_work_column}{row}"
            for row in range(layout.first_day_row, layout.last_day_row + 1)
        ),
        layout.total_hours_cell,
        layout.normal_hours_cell,
        layout.overtime_hours_cell,
        layout.sick_hours_cell,
    ]


def _append_duration_styles(styles: ET.Element, sheet: ET.Element) -> dict[int, int]:
    num_fmts = styles.find(_qname("numFmts"))
    if num_fmts is None:
        num_fmts = ET.Element(_qname("numFmts"))
        styles.insert(0, num_fmts)
    duration_format = next(
        (item for item in num_fmts if item.attrib.get("formatCode") == "[h]:mm"),
        None,
    )
    if duration_format is None:
        format_id = max([163, *(int(item.attrib["numFmtId"]) for item in num_fmts)]) + 1
        duration_format = ET.SubElement(
            num_fmts, _qname("numFmt"),
            {"numFmtId": str(format_id), "formatCode": "[h]:mm"},
        )
    num_fmts.attrib["count"] = str(len(num_fmts))
    cell_xfs = styles.find(_qname("cellXfs"))
    if cell_xfs is None:
        raise ValueError("Monatsvorlage enthält keine Zellformatvorlagen.")
    mapping: dict[int, int] = {}
    for ref in _duration_cell_refs():
        cell = _find_cell(sheet, ref)
        if cell is None:
            raise ValueError(f"Monatsvorlage enthält die erwartete Zelle {ref} nicht.")
        source_id = int(cell.attrib.get("s", "0"))
        if source_id in mapping:
            continue
        cloned_style = deepcopy(cell_xfs[source_id])
        if ref == PAYROLL_MONTH_TEMPLATE_LAYOUT.total_hours_cell:
            # Die schmale Summenzelle nutzt die vorhandene Schrift der Tagesstunden.
            daily_cell = _find_cell(sheet, _duration_cell_refs()[0])
            daily_style = cell_xfs[int(daily_cell.attrib.get("s", "0"))]
            cloned_style.attrib.update(fontId=daily_style.attrib["fontId"], applyFont="1")
        cloned_style.attrib.update(
            numFmtId=duration_format.attrib["numFmtId"], applyNumberFormat="1",
            applyAlignment="1",
        )
        alignment = cloned_style.find(_qname("alignment"))
        if alignment is None:
            alignment = ET.Element(_qname("alignment"))
            cloned_style.insert(0, alignment)
        alignment.attrib.setdefault("horizontal", "left")
        alignment.attrib["shrinkToFit"] = "1"
        mapping[source_id] = len(cell_xfs)
        cell_xfs.append(cloned_style)
    cell_xfs.attrib["count"] = str(len(cell_xfs))
    return mapping


def _apply_duration_cell_styles(sheet: ET.Element, style_mapping: dict[int, int]) -> None:
    for ref in _duration_cell_refs():
        cell = _find_cell(sheet, ref)
        if cell is not None:
            cell.attrib["s"] = str(style_mapping[int(cell.attrib.get("s", "0"))])


def _address_cell_style_ids(sheet: ET.Element) -> set[int]:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    style_ids: set[int] = set()
    for row_number in range(layout.first_day_row, layout.last_day_row + 1):
        cell = _find_cell(sheet, f"{layout.address_column}{row_number}")
        if cell is not None:
            style_ids.add(int(cell.attrib.get("s", "0")))
    return style_ids


def _append_shrink_to_fit_styles(
    styles: ET.Element,
    source_style_ids: Collection[int],
) -> dict[int, int]:
    cell_xfs = styles.find(_qname("cellXfs"))
    if cell_xfs is None:
        raise ValueError("Monatsvorlage enthält keine Zellformatvorlagen.")
    source_styles = list(cell_xfs)
    mapping: dict[int, int] = {}
    for source_style_id in sorted(source_style_ids):
        if source_style_id >= len(source_styles):
            raise ValueError("Monatsvorlage enthält einen ungültigen Zellstil.")
        cloned_style = deepcopy(source_styles[source_style_id])
        alignment = cloned_style.find(_qname("alignment"))
        if alignment is None:
            alignment = ET.SubElement(cloned_style, _qname("alignment"))
        alignment.attrib["shrinkToFit"] = "1"
        cloned_style.attrib["applyAlignment"] = "1"
        mapping[source_style_id] = len(cell_xfs)
        cell_xfs.append(cloned_style)
    cell_xfs.attrib["count"] = str(len(cell_xfs))
    return mapping


def _apply_address_cell_styles(
    sheet: ET.Element,
    style_mapping: dict[int, int],
) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    for row_number in range(layout.first_day_row, layout.last_day_row + 1):
        cell = _find_cell(sheet, f"{layout.address_column}{row_number}")
        if cell is None:
            continue
        source_style_id = int(cell.attrib.get("s", "0"))
        target_style_id = style_mapping.get(source_style_id)
        if target_style_id is not None:
            cell.attrib["s"] = str(target_style_id)


def _site_address(site: Site | None) -> str | None:
    if site is None:
        return None
    street = " ".join(
        value for value in (_clean_text(site.street), _clean_text(site.house_number)) if value
    )
    city = " ".join(
        value for value in (_clean_text(site.postal_code), _clean_text(site.city)) if value
    )
    structured = ", ".join(
        value for value in (street, city, _clean_text(site.address_extra)) if value
    )
    return structured or _clean_text(site.address) or _clean_text(site.location)


def _site_place(site: Site | None) -> str | None:
    if site is None:
        return None
    return (
        _clean_text(site.city)
        or _place_from_text(site.location, allow_unstructured=True)
        or _place_from_text(site.address, allow_unstructured=False)
    )


def _place_from_text(value: str | None, *, allow_unstructured: bool) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    postal_city = POSTAL_CITY_PATTERN.search(text)
    if postal_city is not None:
        return _clean_text(postal_city.group(1))
    parts = [_clean_text(part) for part in text.split(",")]
    parts = [part for part in parts if part]
    if len(parts) > 1 and not any(character.isdigit() for character in parts[-1]):
        return parts[-1]
    return text if allow_unstructured else None


def _overnight_label(status_value: OvernightStatus | None) -> str:
    if status_value == OvernightStatus.SELF_PAID:
        return "MA"
    if status_value == OvernightStatus.BEG_PAID:
        return "BEG"
    return "–"


def _format_clock(value: time | None) -> str:
    return value.strftime("%H:%M") if value is not None else ""


def _format_duration(minutes: int) -> str:
    hours, remainder = divmod(minutes, 60)
    return f"{hours}:{remainder:02d}"


def _clock_minutes(value: time) -> int:
    return value.hour * 60 + value.minute


def _clock_from_minutes(minutes: int) -> time:
    normalized = minutes % (24 * 60)
    return time(normalized // 60, normalized % 60)


def _clean_text(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    return cleaned or None


def _qname(local_name: str) -> str:
    return f"{{{SPREADSHEET_NS}}}{local_name}"


def _find_cell(root: ET.Element, ref: str) -> ET.Element | None:
    for cell in root.findall(f".//{_qname('c')}"):
        if cell.attrib.get("r") == ref:
            return cell
    return None


def _clear_cell(root: ET.Element, ref: str) -> None:
    cell = _find_cell(root, ref)
    if cell is not None:
        _clear_cell_element(cell)


def _set_cell_string(root: ET.Element, ref: str, value: str) -> None:
    cell = _find_cell(root, ref)
    if cell is None:
        raise ValueError(f"Monatsvorlage enthält die erwartete Zelle {ref} nicht.")
    _clear_cell_element(cell)
    if value == "":
        return
    cell.attrib["t"] = "inlineStr"
    inline = ET.SubElement(cell, _qname("is"))
    text_element = ET.SubElement(inline, _qname("t"))
    text_element.text = value


def _set_cell_number(root: ET.Element, ref: str, value: int | float) -> None:
    cell = _find_cell(root, ref)
    if cell is None:
        raise ValueError(f"Monatsvorlage enthält die erwartete Zelle {ref} nicht.")
    _clear_cell_element(cell)
    value_element = ET.SubElement(cell, _qname("v"))
    value_element.text = str(value)


def _set_cell_formula(
    root: ET.Element, ref: str, formula: str, cached_value: float | str
) -> None:
    cell = _find_cell(root, ref)
    if cell is None:
        raise ValueError(f"Monatsvorlage enthält die erwartete Zelle {ref} nicht.")
    _clear_cell_element(cell)
    if isinstance(cached_value, str):
        cell.attrib["t"] = "str"
    ET.SubElement(cell, _qname("f")).text = formula
    ET.SubElement(cell, _qname("v")).text = str(cached_value)


def _clear_cell_element(cell: ET.Element) -> None:
    cell.attrib.pop("t", None)
    for child in list(cell):
        if child.tag in {_qname("v"), _qname("is"), _qname("f")}:
            cell.remove(child)


def _preserve_ignorable_namespaces(document_xml: bytes) -> bytes:
    text = document_xml.decode("utf-8")
    ignorable_match = re.search(r'\bmc:Ignorable="([^"]+)"', text)
    if ignorable_match is None:
        return document_xml
    root_tag_match = re.search(
        r"<(?![!?])(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*\b",
        text,
    )
    if root_tag_match is None:
        return document_xml
    root_tag_end = text.find(">", root_tag_match.end())
    if root_tag_end == -1:
        return document_xml
    for prefix in ignorable_match.group(1).split():
        namespace_uri = SHEET_NAMESPACES.get(prefix)
        if namespace_uri is None or f"xmlns:{prefix}=" in text:
            continue
        declaration = f' xmlns:{prefix}="{namespace_uri}"'
        text = f"{text[:root_tag_end]}{declaration}{text[root_tag_end:]}"
        root_tag_end += len(declaration)
    return text.encode("utf-8")


def unique_payroll_month_sheet_names(person_names: Iterable[str]) -> list[str]:
    used_names: set[str] = set()
    result: list[str] = []
    for person_name in person_names:
        base_name = _payroll_month_sheet_base_name(person_name)
        candidate = _clamp_excel_sheet_name(base_name)
        suffix = 2
        while candidate.casefold() in used_names:
            suffix_text = f" {suffix}"
            candidate = _clamp_excel_sheet_name(base_name, suffix=suffix_text)
            suffix += 1
        used_names.add(candidate.casefold())
        result.append(candidate)
    return result


def _payroll_month_sheet_base_name(person_name: str) -> str:
    cleaned = re.sub(r"\s+", " ", person_name).strip()
    if not cleaned:
        return "Monteur"
    return cleaned.split(" ")[-1] or cleaned


def _clamp_excel_sheet_name(base_name: str, *, suffix: str = "") -> str:
    cleaned = re.sub(r"[\[\]:*?/\\]", " ", base_name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip("' ").strip() or "Monteur"
    max_base_length = max(1, 31 - len(suffix))
    return f"{cleaned[:max_base_length].rstrip()}{suffix}"


def _payroll_month_content_types(content_types_xml: bytes, sheet_count: int) -> bytes:
    text = content_types_xml.decode("utf-8")
    text = re.sub(r'<Override PartName="/xl/worksheets/sheet\d+\.xml"[^>]*/>', "", text)
    text = re.sub(r'<Override PartName="/xl/drawings/drawing\d+\.xml"[^>]*/>', "", text)
    overrides = "".join(
        '<Override '
        f'PartName="/xl/worksheets/sheet{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override '
        f'PartName="/xl/drawings/drawing{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
        for index in range(1, sheet_count + 1)
    )
    return text.replace("</Types>", f"{overrides}</Types>", 1).encode("utf-8")


def _payroll_month_app_properties(app_xml: bytes, sheet_names: Sequence[str]) -> bytes:
    text = app_xml.decode("utf-8")
    titles = "".join(f"<vt:lpstr>{escape(sheet_name)}</vt:lpstr>" for sheet_name in sheet_names)
    text = re.sub(
        r"(<HeadingPairs>.*?<vt:lpstr>Arbeitsblätter</vt:lpstr>.*?<vt:i4>)\d+(</vt:i4>.*?</HeadingPairs>)",
        rf"\g<1>{len(sheet_names)}\g<2>",
        text,
        count=1,
        flags=re.DOTALL,
    )
    titles_xml = (
        f'<TitlesOfParts><vt:vector size="{len(sheet_names)}" baseType="lpstr">'
        f"{titles}</vt:vector></TitlesOfParts>"
    )
    text = re.sub(
        r"<TitlesOfParts>.*?</TitlesOfParts>",
        titles_xml,
        text,
        count=1,
        flags=re.DOTALL,
    )
    return text.encode("utf-8")


def _payroll_month_workbook_xml(workbook_xml: bytes, sheet_names: Sequence[str]) -> bytes:
    text = workbook_xml.decode("utf-8")
    sheets_xml = "<sheets>" + "".join(
        f"<sheet name={quoteattr(sheet_name)} sheetId=\"{index}\" "
        f"r:id=\"rIdSheet{index}\"/>"
        for index, sheet_name in enumerate(sheet_names, start=1)
    ) + "</sheets>"
    return re.sub(r"<sheets>.*?</sheets>", sheets_xml, text, count=1, flags=re.DOTALL).encode(
        "utf-8"
    )


def _payroll_month_workbook_relationships(
    relationships_xml: bytes,
    sheet_count: int,
) -> bytes:
    text = relationships_xml.decode("utf-8")
    relationship_tags = re.findall(r"<Relationship\b[^>]*/>", text)
    preserved_relationships = [
        tag
        for tag in relationship_tags
        if "officeDocument/2006/relationships/worksheet" not in tag
    ]
    sheet_relationships = [
        '<Relationship '
        f'Id="rIdSheet{index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, sheet_count + 1)
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{''.join([*sheet_relationships, *preserved_relationships])}</Relationships>"
    ).encode("utf-8")


def _payroll_month_sheet_relationships(
    sheet_relationships_xml: bytes,
    sheet_index: int,
) -> bytes:
    text = sheet_relationships_xml.decode("utf-8")
    return re.sub(
        r'Target="../drawings/drawing\d+\.xml"',
        f'Target="../drawings/drawing{sheet_index}.xml"',
        text,
    ).encode("utf-8")
