from __future__ import annotations

import calendar
import logging
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Collection, Sequence
from dataclasses import dataclass, replace
from datetime import date, time, timedelta
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, OvernightStatus
from app.models.person import Person
from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_xlsx_template import load_payroll_monthly_template
from app.services.time_entry_rounding import round_minutes_to_quarter_hour


logger = logging.getLogger(__name__)

SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SHEET_NAMESPACES = {
    "": SPREADSHEET_NS,
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "x14ac": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac",
    "xr": "http://schemas.microsoft.com/office/spreadsheetml/2014/revision",
    "xr2": "http://schemas.microsoft.com/office/spreadsheetml/2015/revision2",
    "xr3": "http://schemas.microsoft.com/office/spreadsheetml/2016/revision3",
}
for prefix, uri in SHEET_NAMESPACES.items():
    ET.register_namespace(prefix, uri)

FOUR_DAY_MINIMUM_NET_MINUTES = 10 * 60
DISTRIBUTED_DAILY_NET_MINUTES = 8 * 60
DISTRIBUTED_DAILY_BREAK_MINUTES = 45
DISTRIBUTED_DAILY_SPAN_MINUTES = DISTRIBUTED_DAILY_NET_MINUTES + DISTRIBUTED_DAILY_BREAK_MINUTES


@dataclass(frozen=True)
class PayrollMonthTemplateLayout:
    worksheet_path: str = "xl/worksheets/sheet1.xml"
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
    start_time: time
    end_time: time
    break_minutes: int
    net_work_minutes: int
    commission_number: str | None
    cost_center: str | None
    site_name: str | None
    site_address: str | None
    overnight_status: OvernightStatus | None
    is_derived: bool
    source_entry_ids: tuple[int, ...]


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


@dataclass
class _DominantSiteCandidate:
    site: Site | None
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
        filled_sheet = _preserve_sheet_namespaces(filled_sheet)
        for item in source.infolist():
            content = (
                filled_sheet
                if item.filename == PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path
                else source.read(item.filename)
            )
            archive.writestr(item, content)
    return PayrollMonthWorkbook(content=output.getvalue(), plan=plan)


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
    _clear_month_day_values(sheet, year=year, month=month)
    for day in plan.days:
        _write_month_day(sheet, day)
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
    overtime_remainders: list[PayrollWeekOvertimeRemainder] = []

    for week_start in _month_week_starts(year, month):
        weekdays = [week_start + timedelta(days=offset) for offset in range(5)]
        actual_days = [
            days_by_date[work_date] for work_date in weekdays if work_date in days_by_date
        ]
        missing_dates = [work_date for work_date in weekdays if work_date not in days_by_date]
        if (
            len(actual_days) != 4
            or len(missing_dates) != 1
            or any(day.net_work_minutes < FOUR_DAY_MINIMUM_NET_MINUTES for day in actual_days)
            or missing_dates[0] in blocked_dates
        ):
            continue

        actual_days.sort(key=lambda day: day.work_date)
        actual_week_minutes = sum(day.net_work_minutes for day in actual_days)
        for day in actual_days:
            days_by_date[day.work_date] = _distributed_actual_day(day)

        last_actual_day = actual_days[-1]
        missing_date = missing_dates[0]
        derived_start = last_actual_day.start_time
        days_by_date[missing_date] = PayrollMonthDay(
            work_date=missing_date,
            start_time=derived_start,
            end_time=_clock_from_minutes(
                _clock_minutes(derived_start) + DISTRIBUTED_DAILY_SPAN_MINUTES
            ),
            break_minutes=DISTRIBUTED_DAILY_BREAK_MINUTES,
            net_work_minutes=DISTRIBUTED_DAILY_NET_MINUTES,
            commission_number=last_actual_day.commission_number,
            cost_center=last_actual_day.cost_center,
            site_name=last_actual_day.site_name,
            site_address=last_actual_day.site_address,
            overnight_status=None,
            is_derived=True,
            source_entry_ids=(),
        )
        overtime_minutes = max(0, actual_week_minutes - 5 * DISTRIBUTED_DAILY_NET_MINUTES)
        if overtime_minutes > 0:
            iso_year, iso_week, _ = week_start.isocalendar()
            overtime_remainders.append(
                PayrollWeekOvertimeRemainder(
                    iso_year=iso_year,
                    iso_week=iso_week,
                    minutes=overtime_minutes,
                )
            )
            logger.info(
                "Monatsabrechnung hält %s Mehrarbeitsminuten für KW %s/%s zurück.",
                overtime_minutes,
                iso_week,
                iso_year,
            )

    month_days = tuple(
        day
        for work_date, day in sorted(days_by_date.items())
        if work_date.year == year and work_date.month == month
    )
    return PayrollMonthPlan(
        days=month_days,
        overtime_remainders=tuple(overtime_remainders),
    )


def _build_actual_payroll_day(
    work_date: date,
    entries: Sequence[WorkTimeEntry],
) -> PayrollMonthDay | None:
    timed_entries = [entry for entry in entries if _entry_interval(entry) is not None]
    if not timed_entries:
        return None
    intervals = [_entry_interval(entry) for entry in timed_entries]
    valid_intervals = [interval for interval in intervals if interval is not None]
    first_start = min(interval[0] for interval in valid_intervals)
    last_end = max(interval[1] for interval in valid_intervals)
    rounded_start = round_minutes_to_quarter_hour(first_start)
    rounded_end = round_minutes_to_quarter_hour(last_end)
    break_minutes = sum(_entry_break_minutes(entry) for entry in timed_entries)
    net_work_minutes = max(0, rounded_end - rounded_start - break_minutes)
    dominant_site = _dominant_site(timed_entries)
    site = dominant_site.site
    return PayrollMonthDay(
        work_date=work_date,
        start_time=_clock_from_minutes(rounded_start),
        end_time=_clock_from_minutes(rounded_end),
        break_minutes=break_minutes,
        net_work_minutes=net_work_minutes,
        commission_number=_clean_text(getattr(site, "site_number", None)),
        cost_center=None,
        site_name=_clean_text(getattr(site, "name", None)),
        site_address=_site_address(site),
        overnight_status=_day_overnight_status(timed_entries),
        is_derived=False,
        source_entry_ids=tuple(sorted(entry.id for entry in timed_entries if entry.id is not None)),
    )


def _dominant_site(entries: Sequence[WorkTimeEntry]) -> _DominantSiteCandidate:
    candidates: dict[tuple[object, ...], _DominantSiteCandidate] = {}
    for entry in entries:
        interval = _entry_interval(entry)
        if interval is None:
            continue
        start_minutes, end_minutes = interval
        duration_minutes = max(
            0,
            end_minutes - start_minutes - _entry_break_minutes(entry),
        )
        site = entry.site
        key = _site_group_key(entry, site)
        candidate = candidates.setdefault(key, _DominantSiteCandidate(site=site))
        candidate.duration_minutes += duration_minutes
        entry_order = (start_minutes, end_minutes, entry.id or -1)
        if entry_order > candidate.latest_entry_order:
            candidate.latest_entry_order = entry_order
            candidate.site = site
    return max(
        candidates.values(),
        key=lambda candidate: (
            candidate.duration_minutes,
            candidate.latest_entry_order,
        ),
    )


def _site_group_key(entry: WorkTimeEntry, site: Site | None) -> tuple[object, ...]:
    if site is None:
        return ("missing", entry.site_id)
    if site.id is not None:
        return ("site-id", site.id)
    return (
        "site-values",
        _clean_text(site.site_number),
        _clean_text(site.name),
        _site_address(site),
    )


def _is_valid_time_entry(entry: WorkTimeEntry) -> bool:
    return entry.source != "gps_suggestion" and _entry_interval(entry) is not None


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


def _distributed_actual_day(day: PayrollMonthDay) -> PayrollMonthDay:
    start_minutes = _clock_minutes(day.start_time)
    return replace(
        day,
        end_time=_clock_from_minutes(start_minutes + DISTRIBUTED_DAILY_SPAN_MINUTES),
        break_minutes=DISTRIBUTED_DAILY_BREAK_MINUTES,
        net_work_minutes=DISTRIBUTED_DAILY_NET_MINUTES,
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


def _write_month_day(sheet: ET.Element, day: PayrollMonthDay) -> None:
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    row_number = layout.first_day_row + day.work_date.day - 1
    _set_cell_string(sheet, f"{layout.start_column}{row_number}", _format_clock(day.start_time))
    _set_cell_string(sheet, f"{layout.end_column}{row_number}", _format_clock(day.end_time))
    _set_cell_string(
        sheet,
        f"{layout.break_column}{row_number}",
        _format_duration(day.break_minutes),
    )
    _set_cell_string(
        sheet,
        f"{layout.net_work_column}{row_number}",
        _format_duration(day.net_work_minutes),
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
        day.site_address or "",
    )


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


def _overnight_label(status_value: OvernightStatus | None) -> str:
    if status_value == OvernightStatus.SELF_PAID:
        return "MA"
    if status_value == OvernightStatus.BEG_PAID:
        return "BEG"
    return "–"


def _format_clock(value: time) -> str:
    return value.strftime("%H:%M")


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


def _set_cell_number(root: ET.Element, ref: str, value: int) -> None:
    cell = _find_cell(root, ref)
    if cell is None:
        raise ValueError(f"Monatsvorlage enthält die erwartete Zelle {ref} nicht.")
    _clear_cell_element(cell)
    value_element = ET.SubElement(cell, _qname("v"))
    value_element.text = str(value)


def _clear_cell_element(cell: ET.Element) -> None:
    cell.attrib.pop("t", None)
    for child in list(cell):
        if child.tag in {_qname("v"), _qname("is"), _qname("f")}:
            cell.remove(child)


def _preserve_sheet_namespaces(sheet_xml: bytes) -> bytes:
    text = sheet_xml.decode("utf-8")
    ignorable_match = re.search(r'\bmc:Ignorable="([^"]+)"', text)
    if ignorable_match is None:
        return sheet_xml
    for prefix in ignorable_match.group(1).split():
        namespace_uri = SHEET_NAMESPACES.get(prefix)
        if namespace_uri is None or f"xmlns:{prefix}=" in text:
            continue
        declaration = f' xmlns:{prefix}="{namespace_uri}"'
        text = re.sub(r"(<worksheet\b[^>]*)(>)", rf"\1{declaration}\2", text, count=1)
    return text.encode("utf-8")
