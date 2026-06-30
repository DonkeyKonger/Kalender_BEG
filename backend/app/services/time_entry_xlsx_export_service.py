from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, timedelta, time
from importlib import resources
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.person import Person
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.gps_service import NOTICE_GPS_NOT_CHECKABLE, GpsPresenceEvaluation, GpsPresenceService
from app.services.time_entry_service import GPS_TIME_REVIEW_TOLERANCE_MINUTES, TimeEntryService


PACKAGE_RELATIONSHIP_CONTENT_TYPE = (
    "application/vnd.openxmlformats-package.relationships+xml"
)
OFFICE_DOCUMENT_RELATIONSHIP_BASE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
)
EXPORT_HEADERS = [
    "Tag",
    "Datum",
    "Baustellennummer",
    "Baustellenname",
    "Eingetragene Zeit (durch Monteur)",
    "Geprüfte Zeit (durch Büro)",
    "Notiz",
]
EXPORT_COLUMN_WIDTHS = [10, 14, 18, 34, 28, 25, 44]
WEEKLY_WORKER_HEADERS = [
    "Tag",
    "Datum",
    "Baustellennummer",
    "Baustelle",
    "Montagebeginn",
    "Montageende",
    "Pause",
    "Montagezeit",
    "Ort geprüft",
    "Arbeitszeit geprüft",
    "Bürozeit / korrigierte Arbeitszeit",
    "Status / Hinweis",
]
WEEKLY_WORKER_COLUMN_WIDTHS = [10, 14, 18, 34, 16, 16, 12, 16, 14, 18, 30, 42]
EXPORTABLE_CORRECTION_METHODS = {"accept_gps", "manual_correction", "assign_site"}
EXPORTABLE_MANUAL_STATUSES = {"manually_approved", "not_verifiable", "auto_closed_by_deadline"}
GERMAN_WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
WEEKLY_WORKER_TABLE_NAME = "LohnpruefungMonteurwoche"
WEEKLY_WORKER_HEADER_ROW_INDEX = 8
WEEKLY_WORKER_DATA_START_ROW_INDEX = WEEKLY_WORKER_HEADER_ROW_INDEX + 1
WEEKLY_WORKER_LOGO_RESOURCE = "assets/beg_logo_icon.png"
WEEKLY_WORKER_TEMPLATE_RESOURCE = "templates/time_entries/Wochenbericht_Digital_Master.xlsx"
WEEKLY_WORKER_TEMPLATE_DATA_START_ROW = 15
WEEKLY_WORKER_TEMPLATE_DATA_END_ROW = 24
WEEKLY_WORKER_TEMPLATE_TOTAL_ROW = 26
WEEKLY_WORKER_TEMPLATE_DATA_STYLES = {
    "A": "19",
    "B": "5",
    "C": "35",
    "G": "34",
    "J": "7",
    "K": "7",
    "L": "8",
    "M": "7",
    "N": "7",
    "O": "20",
}
EXCEL_EPOCH = date(1899, 12, 30)
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


@dataclass(frozen=True)
class TimeEntryExportRow:
    person_name: str
    work_date: date
    site_number: str
    site_name: str
    reported_minutes: int | None
    checked_minutes: int | None
    note: str


@dataclass(frozen=True)
class WeeklyWorkerExportRow:
    work_date: date
    entry: WorkTimeEntry | None
    gps_evaluation: GpsPresenceEvaluation | None = None
    has_multiple_entries_on_day: bool = False


class TimeEntryXlsxExportService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def monthly_export(self, *, year: int, month: int, current_user: User) -> bytes:
        if month < 1 or month > 12:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "month muss zwischen 1 und 12 liegen.")
        if year < 2000 or year > 2100:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "year ist ausserhalb des erlaubten Bereichs.",
            )

        date_from, date_to = month_range(year, month)
        entries = TimeEntryService(self.db).list_entries(
            current_user=current_user,
            date_from=date_from,
            date_to=date_to,
        )
        gps_service = GpsPresenceService(self.db)
        gps_evaluations = {entry.id: gps_service.evaluate_time_entry(entry) for entry in entries}
        rows = [
            self._export_row(entry, gps_evaluations.get(entry.id))
            for entry in entries
            if is_exportable_time_entry(entry, gps_evaluations.get(entry.id))
        ]
        return build_xlsx_workbook(group_rows_by_person(rows))

    def weekly_worker_export(self, *, person_id: int, week_start: date, current_user: User) -> bytes:
        start = week_start - timedelta(days=week_start.weekday())
        end = start + timedelta(days=6)
        person = self.db.get(Person, person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")

        entries = TimeEntryService(self.db).list_entries(
            current_user=current_user,
            person_id=person_id,
            date_from=start,
            date_to=end,
        )
        entries = [entry for entry in entries if entry.source != "gps_suggestion"]
        entries.sort(key=lambda entry: (entry.work_date, site_number(entry), site_name(entry), entry.id))
        gps_service = GpsPresenceService(self.db)
        gps_evaluations = {entry.id: gps_service.evaluate_time_entry(entry) for entry in entries}

        iso_week = start.isocalendar()
        return build_weekly_worker_xlsx(
            person_name=person.display_name,
            week_number=iso_week.week,
            year=iso_week.year,
            start=start,
            end=end,
            rows=weekly_worker_rows(start, end, entries, gps_evaluations),
        )

    def _export_row(
        self,
        entry: WorkTimeEntry,
        gps_evaluation: GpsPresenceEvaluation | None,
    ) -> TimeEntryExportRow:
        reported_minutes = (
            entry.original_work_minutes
            if entry.original_work_minutes is not None
            else entry.work_minutes
        )
        checked_minutes = (
            entry.corrected_work_minutes
            if entry.corrected_work_minutes is not None
            else entry.work_minutes
        )
        return TimeEntryExportRow(
            person_name=entry.person.display_name if entry.person else f"Person {entry.person_id}",
            work_date=entry.work_date,
            site_number=entry.site.site_number if entry.site and entry.site.site_number else "",
            site_name=entry.site.name if entry.site and entry.site.name else "",
            reported_minutes=reported_minutes,
            checked_minutes=checked_minutes,
            note=export_note(entry, gps_evaluation),
        )


def month_range(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    if month == 12:
        end = date(year, 12, 31)
    else:
        end = date(year, month + 1, 1)
        end = date.fromordinal(end.toordinal() - 1)
    return start, end


def is_exportable_time_entry(
    entry: WorkTimeEntry,
    gps_evaluation: GpsPresenceEvaluation | None,
) -> bool:
    if is_auto_plausible_entry(entry, gps_evaluation):
        return True
    if (
        entry.time_review_status == "corrected"
        or entry.corrected_work_minutes is not None
        or entry.time_review_method in EXPORTABLE_CORRECTION_METHODS
    ):
        return True
    return entry.time_review_status in EXPORTABLE_MANUAL_STATUSES


def is_auto_plausible_entry(
    entry: WorkTimeEntry,
    gps_evaluation: GpsPresenceEvaluation | None,
) -> bool:
    if gps_evaluation is None or gps_evaluation.work_minutes is None:
        return False
    if gps_evaluation.review_notices:
        return False
    return (
        abs(gps_evaluation.work_minutes - entry.work_minutes)
        <= GPS_TIME_REVIEW_TOLERANCE_MINUTES
    )


def export_note(entry: WorkTimeEntry, gps_evaluation: GpsPresenceEvaluation | None) -> str:
    if entry.note:
        return entry.note
    if entry.time_review_status == "corrected" or entry.corrected_work_minutes is not None:
        return "Korrigierte Zeit durch Büro"
    if entry.time_review_method == "accept_gps":
        return "GPS-Zeit übernommen"
    if entry.time_review_method == "assign_site":
        return "Einsatzort durch Büro geprüft"
    if entry.time_review_status in EXPORTABLE_MANUAL_STATUSES:
        return "Manuell geprüft"
    if is_auto_plausible_entry(entry, gps_evaluation):
        return "automatisch geprüft"
    if gps_evaluation and gps_evaluation.review_notices:
        return "; ".join(gps_evaluation.review_notices)
    return ""


def group_rows_by_person(rows: Iterable[TimeEntryExportRow]) -> dict[str, list[TimeEntryExportRow]]:
    grouped: dict[str, list[TimeEntryExportRow]] = {}
    for row in rows:
        grouped.setdefault(row.person_name, []).append(row)
    for person_rows in grouped.values():
        person_rows.sort(key=lambda row: (row.work_date, row.site_number, row.site_name))
    return dict(sorted(grouped.items(), key=lambda item: item[0].casefold()))


def build_xlsx_workbook(rows_by_person: dict[str, list[TimeEntryExportRow]]) -> bytes:
    sheets = build_sheet_payloads(rows_by_person)
    return build_xlsx_archive(sheets, EXPORT_COLUMN_WIDTHS)


def build_xlsx_archive(sheets: list[dict[str, object]], column_widths: list[int]) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types_xml(len(sheets)))
        archive.writestr("_rels/.rels", package_relationships_xml())
        archive.writestr("xl/workbook.xml", workbook_xml(sheets))
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_relationships_xml(len(sheets)))
        archive.writestr("xl/styles.xml", styles_xml())
        for index, sheet in enumerate(sheets, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", worksheet_xml(sheet["rows"], column_widths))
    return output.getvalue()


def build_weekly_worker_xlsx(
    *,
    person_name: str,
    week_number: int,
    year: int,
    start: date,
    end: date,
    rows: list[WeeklyWorkerExportRow],
) -> bytes:
    template = load_weekly_worker_template()
    output = BytesIO()
    with ZipFile(BytesIO(template), "r") as source, ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for item in source.infolist():
            content = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                content = fill_weekly_worker_template_sheet(
                    content,
                    person_name=person_name,
                    week_number=week_number,
                    year=year,
                    start=start,
                    end=end,
                    rows=rows,
                )
            archive.writestr(item, content)
    return output.getvalue()


def load_weekly_worker_template() -> bytes:
    return resources.files("app").joinpath(WEEKLY_WORKER_TEMPLATE_RESOURCE).read_bytes()


def load_weekly_worker_logo() -> bytes | None:
    try:
        return resources.files("app").joinpath(WEEKLY_WORKER_LOGO_RESOURCE).read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return None


def fill_weekly_worker_template_sheet(
    sheet_xml: bytes,
    *,
    person_name: str,
    week_number: int,
    year: int,
    start: date,
    end: date,
    rows: list[WeeklyWorkerExportRow],
) -> bytes:
    root = ET.fromstring(sheet_xml)
    data_row_count = max(len(rows), 1)
    template_row_count = (
        WEEKLY_WORKER_TEMPLATE_DATA_END_ROW - WEEKLY_WORKER_TEMPLATE_DATA_START_ROW + 1
    )
    extra_rows = max(0, data_row_count - template_row_count)
    if extra_rows:
        insert_weekly_worker_template_rows(root, extra_rows)

    final_total_row = WEEKLY_WORKER_TEMPLATE_TOTAL_ROW + extra_rows
    set_cell_string(root, "C5", start.strftime("%d.%m.%Y"))
    set_cell_string(root, "E5", end.strftime("%d.%m.%Y"))
    set_cell_string(root, "H5", str(week_number))
    set_cell_string(root, "B7", person_name)

    for row_number in range(
        WEEKLY_WORKER_TEMPLATE_DATA_START_ROW,
        WEEKLY_WORKER_TEMPLATE_DATA_START_ROW + template_row_count + extra_rows,
    ):
        clear_weekly_worker_data_row(root, row_number)

    total_minutes = 0
    previous_date: date | None = None
    for index, row in enumerate(rows):
        row_number = WEEKLY_WORKER_TEMPLATE_DATA_START_ROW + index
        total_minutes += weekly_worker_total_minutes(row)
        fill_weekly_worker_data_row(
            root,
            row_number,
            row,
            show_weekday=row.work_date != previous_date,
        )
        previous_date = row.work_date

    set_cell_string(root, f"O{final_total_row}", format_export_hours(total_minutes))
    update_sheet_dimension(root, 32 + extra_rows)
    return preserve_weekly_worker_sheet_namespaces(
        ET.tostring(root, encoding="utf-8", xml_declaration=True)
    )


def preserve_weekly_worker_sheet_namespaces(sheet_xml: bytes) -> bytes:
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


def insert_weekly_worker_template_rows(root: ET.Element, extra_rows: int) -> None:
    sheet_data = root.find(qname("sheetData"))
    if sheet_data is None:
        return
    clone_source = find_sheet_row(root, WEEKLY_WORKER_TEMPLATE_DATA_END_ROW)
    if clone_source is None:
        return

    for row in sheet_data.findall(qname("row")):
        row_number = int(row.attrib["r"])
        if row_number >= WEEKLY_WORKER_TEMPLATE_TOTAL_ROW - 1:
            move_row(row, row_number + extra_rows)

    rows = list(sheet_data.findall(qname("row")))
    insert_at = next(
        (
            index
            for index, row in enumerate(rows)
            if int(row.attrib["r"]) > WEEKLY_WORKER_TEMPLATE_DATA_END_ROW
        ),
        len(rows),
    )
    for offset in range(extra_rows):
        new_row_number = WEEKLY_WORKER_TEMPLATE_DATA_END_ROW + 1 + offset
        new_row = deepcopy(clone_source)
        move_row(new_row, new_row_number)
        sheet_data.insert(insert_at + offset, new_row)

    shift_merge_cells(root, start_row=WEEKLY_WORKER_TEMPLATE_TOTAL_ROW - 1, offset=extra_rows)
    add_weekly_worker_data_merges(root, WEEKLY_WORKER_TEMPLATE_DATA_END_ROW + 1, extra_rows)


def clear_weekly_worker_data_row(root: ET.Element, row_number: int) -> None:
    apply_weekly_worker_data_row_styles(root, row_number)
    for column in ["A", "B", "C", "G", "J", "K", "L", "M", "N", "O"]:
        clear_cell(root, f"{column}{row_number}")


def fill_weekly_worker_data_row(
    root: ET.Element,
    row_number: int,
    row: WeeklyWorkerExportRow,
    *,
    show_weekday: bool,
) -> None:
    apply_weekly_worker_data_row_styles(root, row_number)
    set_cell_string(
        root,
        f"A{row_number}",
        GERMAN_WEEKDAYS[row.work_date.weekday()] if show_weekday else "",
    )
    set_cell_number(root, f"B{row_number}", excel_date_serial(row.work_date))

    entry = row.entry
    if entry is None:
        set_cell_string(root, f"C{row_number}", "Keine Zeitmeldung")
        return

    set_cell_string(root, f"C{row_number}", weekly_worker_site_label(entry))
    set_cell_number_or_blank(root, f"J{row_number}", excel_time_serial(weekly_worker_start_time(entry)))
    set_cell_number_or_blank(root, f"K{row_number}", excel_time_serial(weekly_worker_end_time(entry)))
    set_cell_number(root, f"L{row_number}", (entry.break_minutes or 0) / 60)
    set_cell_string(root, f"O{row_number}", format_export_hours(weekly_worker_total_minutes(row)))


def apply_weekly_worker_data_row_styles(root: ET.Element, row_number: int) -> None:
    for column, style_id in WEEKLY_WORKER_TEMPLATE_DATA_STYLES.items():
        set_cell_style(root, f"{column}{row_number}", style_id)


def weekly_worker_site_label(entry: WorkTimeEntry) -> str:
    number = site_number(entry)
    name = site_name(entry)
    if number and name:
        return f"{number} - {name}"
    return name or number or "Keine Baustelle"


def weekly_worker_start_time(entry: WorkTimeEntry) -> time | None:
    return entry.payroll_corrected_start_time or entry.start_time


def weekly_worker_end_time(entry: WorkTimeEntry) -> time | None:
    return entry.payroll_corrected_end_time or entry.end_time


def weekly_worker_work_minutes(entry: WorkTimeEntry) -> int:
    if entry.payroll_corrected_work_minutes is not None:
        return entry.payroll_corrected_work_minutes
    payroll_minutes = duration_minutes(
        entry.payroll_corrected_start_time,
        entry.payroll_corrected_end_time,
        entry.break_minutes,
    )
    if payroll_minutes is not None:
        return payroll_minutes
    if entry.work_minutes > 0:
        return entry.work_minutes
    entry_minutes = duration_minutes(entry.start_time, entry.end_time, entry.break_minutes)
    return entry_minutes if entry_minutes is not None else entry.work_minutes


def weekly_worker_total_minutes(row: WeeklyWorkerExportRow) -> int:
    if row.entry is None:
        return 0
    return weekly_worker_work_minutes(row.entry) + (row.entry.travel_minutes or 0)


def duration_minutes(start_time: time | None, end_time: time | None, break_minutes: int) -> int | None:
    if start_time is None or end_time is None:
        return None
    start_minutes = start_time.hour * 60 + start_time.minute
    end_minutes = end_time.hour * 60 + end_time.minute
    if end_minutes <= start_minutes:
        return None
    return max(0, end_minutes - start_minutes - (break_minutes or 0))


def find_sheet_row(root: ET.Element, row_number: int) -> ET.Element | None:
    sheet_data = root.find(qname("sheetData"))
    if sheet_data is None:
        return None
    for row in sheet_data.findall(qname("row")):
        if int(row.attrib["r"]) == row_number:
            return row
    return None


def move_row(row: ET.Element, row_number: int) -> None:
    row.attrib["r"] = str(row_number)
    for cell in row.findall(qname("c")):
        column = cell_column(cell.attrib["r"])
        cell.attrib["r"] = f"{column}{row_number}"


def shift_merge_cells(root: ET.Element, *, start_row: int, offset: int) -> None:
    merge_cells = root.find(qname("mergeCells"))
    if merge_cells is None:
        return
    for merge_cell in merge_cells.findall(qname("mergeCell")):
        merge_cell.attrib["ref"] = shift_range_ref(
            merge_cell.attrib["ref"],
            start_row=start_row,
            offset=offset,
        )


def add_weekly_worker_data_merges(root: ET.Element, start_row: int, count: int) -> None:
    merge_cells = root.find(qname("mergeCells"))
    if merge_cells is None:
        return
    for row_number in range(start_row, start_row + count):
        ET.SubElement(merge_cells, qname("mergeCell"), {"ref": f"C{row_number}:F{row_number}"})
        ET.SubElement(merge_cells, qname("mergeCell"), {"ref": f"G{row_number}:I{row_number}"})
    merge_cells.attrib["count"] = str(len(merge_cells.findall(qname("mergeCell"))))


def shift_range_ref(range_ref: str, *, start_row: int, offset: int) -> str:
    def replace(match: re.Match[str]) -> str:
        column = match.group(1)
        row_number = int(match.group(2))
        if row_number >= start_row:
            row_number += offset
        return f"{column}{row_number}"

    return re.sub(r"([A-Z]+)([0-9]+)", replace, range_ref)


def update_sheet_dimension(root: ET.Element, last_row: int) -> None:
    dimension = root.find(qname("dimension"))
    if dimension is not None:
        dimension.attrib["ref"] = f"A1:O{last_row}"


def set_cell_string(root: ET.Element, ref: str, value: str) -> None:
    cell = find_cell(root, ref)
    if cell is None:
        return
    clear_cell_element(cell)
    if value == "":
        return
    cell.attrib["t"] = "inlineStr"
    inline = ET.SubElement(cell, qname("is"))
    text = ET.SubElement(inline, qname("t"))
    text.text = value


def set_cell_number(root: ET.Element, ref: str, value: int | float) -> None:
    cell = find_cell(root, ref)
    if cell is None:
        return
    clear_cell_element(cell)
    value_element = ET.SubElement(cell, qname("v"))
    value_element.text = format_excel_number(value)


def set_cell_number_or_blank(root: ET.Element, ref: str, value: float | None) -> None:
    if value is None:
        clear_cell(root, ref)
    else:
        set_cell_number(root, ref, value)


def clear_cell(root: ET.Element, ref: str) -> None:
    cell = find_cell(root, ref)
    if cell is not None:
        clear_cell_element(cell)


def set_cell_style(root: ET.Element, ref: str, style_id: str) -> None:
    cell = find_cell(root, ref)
    if cell is not None:
        cell.attrib["s"] = style_id


def clear_cell_element(cell: ET.Element) -> None:
    cell.attrib.pop("t", None)
    for child in list(cell):
        if child.tag in {qname("v"), qname("is"), qname("f")}:
            cell.remove(child)


def find_cell(root: ET.Element, ref: str) -> ET.Element | None:
    row_number = cell_row(ref)
    row = find_sheet_row(root, row_number)
    if row is None:
        return None
    for cell in row.findall(qname("c")):
        if cell.attrib.get("r") == ref:
            return cell
    return None


def qname(local_name: str) -> str:
    return f"{{{SPREADSHEET_NS}}}{local_name}"


def cell_column(ref: str) -> str:
    match = re.match(r"([A-Z]+)", ref)
    return match.group(1) if match else ref


def cell_row(ref: str) -> int:
    match = re.search(r"([0-9]+)$", ref)
    return int(match.group(1)) if match else 0


def excel_date_serial(value: date) -> int:
    return (value - EXCEL_EPOCH).days


def excel_time_serial(value: time | None) -> float | None:
    if value is None:
        return None
    return (value.hour * 3600 + value.minute * 60 + value.second) / 86400


def format_excel_number(value: int | float) -> str:
    if isinstance(value, int) or float(value).is_integer():
        return str(int(value))
    return f"{value:.12g}"


def build_sheet_payloads(
    rows_by_person: dict[str, list[TimeEntryExportRow]],
) -> list[dict[str, object]]:
    if not rows_by_person:
        return [{
            "name": "Keine Daten",
            "rows": [["Hinweis"], ["Keine exportierbaren Zeiten im ausgewählten Monat."]],
        }]

    used_sheet_names: set[str] = set()
    sheets: list[dict[str, object]] = []
    for person_name, rows in rows_by_person.items():
        sheet_rows = [EXPORT_HEADERS]
        sheet_rows.extend(export_row_values(row) for row in rows)
        sheets.append({
            "name": unique_sheet_name(person_name, used_sheet_names),
            "rows": sheet_rows,
        })
    return sheets


def export_row_values(row: TimeEntryExportRow) -> list[str]:
    return [
        GERMAN_WEEKDAYS[row.work_date.weekday()],
        row.work_date.strftime("%d.%m.%Y"),
        row.site_number,
        row.site_name,
        format_export_hours(row.reported_minutes),
        format_export_hours(row.checked_minutes),
        row.note,
    ]


def weekly_worker_rows(
    start: date,
    end: date,
    entries: list[WorkTimeEntry],
    gps_evaluations: dict[int, GpsPresenceEvaluation],
) -> list[WeeklyWorkerExportRow]:
    entries_by_date: dict[date, list[WorkTimeEntry]] = {}
    for entry in entries:
        entries_by_date.setdefault(entry.work_date, []).append(entry)

    rows: list[WeeklyWorkerExportRow] = []
    cursor = start
    while cursor <= end:
        day_entries = entries_by_date.get(cursor, [])
        if not day_entries:
            rows.append(WeeklyWorkerExportRow(work_date=cursor, entry=None))
        else:
            has_multiple = len(day_entries) > 1
            rows.extend(
                WeeklyWorkerExportRow(
                    work_date=cursor,
                    entry=entry,
                    gps_evaluation=gps_evaluations.get(entry.id),
                    has_multiple_entries_on_day=has_multiple,
                )
                for entry in day_entries
            )
        cursor += timedelta(days=1)
    return rows


def weekly_worker_row_values(row: WeeklyWorkerExportRow) -> list[object]:
    entry = row.entry
    gps_evaluation = row.gps_evaluation
    if entry is None:
        return [
            GERMAN_WEEKDAYS[row.work_date.weekday()],
            row.work_date,
            "",
            "Keine Zeitmeldung",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "Keine Zeitmeldung",
        ]

    payroll_minutes = (
        entry.payroll_corrected_work_minutes
        if entry.payroll_corrected_work_minutes is not None
        else entry.work_minutes
    )
    return [
        GERMAN_WEEKDAYS[row.work_date.weekday()],
        row.work_date,
        site_number(entry),
        site_name(entry) or "Keine Baustelle",
        format_clock(entry.start_time),
        format_clock(entry.end_time),
        format_minutes(entry.break_minutes),
        format_export_hours(payroll_minutes),
        check_state_label(classify_location_check(entry, gps_evaluation)),
        check_state_label(classify_time_check(entry, gps_evaluation, has_multiple_entries_on_day=row.has_multiple_entries_on_day)),
        payroll_correction_label(entry),
        weekly_worker_status_note(entry, gps_evaluation),
    ]


def classify_location_check(entry: WorkTimeEntry, gps_evaluation: GpsPresenceEvaluation | None) -> str:
    if gps_evaluation is None:
        return "unknown"
    has_gps_signal = bool(gps_evaluation.first_seen_at or gps_evaluation.last_seen_at or gps_evaluation.total_points)
    if gps_evaluation.gps_not_checkable or gps_evaluation.status == "not_checkable" or NOTICE_GPS_NOT_CHECKABLE in gps_evaluation.review_notices:
        return "unknown"
    if gps_evaluation.status == "missing" or not has_gps_signal:
        return "ok" if entry.time_review_status not in {"open", "not_verifiable"} else "unknown"
    if (
        gps_evaluation.status == "mismatch"
        or gps_evaluation.planned_vs_gps_mismatch
        or gps_evaluation.manual_vs_gps_mismatch
        or gps_evaluation.manual_vs_planned_mismatch
        or (
            gps_evaluation.gps_detected_location_type == "company"
            and bool(entry.site_id or gps_evaluation.planned_site_labels)
        )
    ):
        return "warning"
    if gps_evaluation.status == "matched" or entry.time_review_status != "open":
        return "ok"
    return "unknown"


def classify_time_check(
    entry: WorkTimeEntry,
    gps_evaluation: GpsPresenceEvaluation | None,
    *,
    has_multiple_entries_on_day: bool,
) -> str:
    if entry.time_review_status != "open":
        return "unknown" if entry.time_review_status in {"not_verifiable", "clarification"} else "ok"
    if entry.source == "gps_suggestion":
        return "warning"
    manual_minutes = entry.work_minutes
    gps_minutes = gps_evaluation.work_minutes if gps_evaluation else None
    if manual_minutes is not None and manual_minutes > 12 * 60:
        return "warning"
    if manual_minutes is None or gps_minutes is None:
        return "unknown"
    if has_multiple_entries_on_day:
        return "unknown"
    return "ok" if abs(gps_minutes - manual_minutes) <= GPS_TIME_REVIEW_TOLERANCE_MINUTES else "warning"


def check_state_label(state: str) -> str:
    if state == "ok":
        return "OK"
    if state == "warning":
        return "Warnung"
    return "-"


def payroll_correction_label(entry: WorkTimeEntry) -> str:
    if (
        entry.payroll_corrected_start_time is None
        and entry.payroll_corrected_end_time is None
        and entry.payroll_corrected_work_minutes is None
    ):
        return "-"
    time_range = " - ".join(
        value
        for value in [format_clock(entry.payroll_corrected_start_time), format_clock(entry.payroll_corrected_end_time)]
        if value != "-"
    )
    hours = format_export_hours(entry.payroll_corrected_work_minutes)
    return " · ".join(value for value in [time_range, hours] if value)


def weekly_worker_status_note(entry: WorkTimeEntry, gps_evaluation: GpsPresenceEvaluation | None) -> str:
    notes: list[str] = []
    if entry.payroll_reviewed_at is not None:
        notes.append("Zeile geprüft")
    if entry.payroll_corrected_work_minutes is not None:
        notes.append("Bürozeit geprüft")
    if gps_evaluation and gps_evaluation.mismatch_notice:
        notes.append(gps_evaluation.mismatch_notice)
    if gps_evaluation:
        notes.extend(note for note in gps_evaluation.review_notices if note)
    if entry.note:
        notes.append(entry.note)
    return "; ".join(dict.fromkeys(notes)) or "-"


def site_number(entry: WorkTimeEntry) -> str:
    return entry.site.site_number if entry.site and entry.site.site_number else ""


def site_name(entry: WorkTimeEntry) -> str:
    return entry.site.name if entry.site and entry.site.name else ""


def format_clock(value: time | None) -> str:
    return value.strftime("%H:%M") if value else "-"


def format_minutes(minutes: int | None) -> str:
    if minutes is None:
        return "-"
    return f"{minutes} min"


def format_export_hours(minutes: int | None) -> str:
    if minutes is None:
        return ""
    value = f"{minutes / 60:.2f}".rstrip("0").rstrip(".")
    if "." not in value:
        value = f"{value}.0"
    return f"{value.replace('.', ',')} h"


def unique_sheet_name(value: str, used_names: set[str]) -> str:
    cleaned = "".join("_" if char in "[]:*?/\\" else char for char in value).strip() or "Monteur"
    base = cleaned[:31]
    candidate = base
    suffix = 2
    while candidate.casefold() in used_names:
        suffix_text = f" {suffix}"
        candidate = f"{base[:31 - len(suffix_text)]}{suffix_text}"
        suffix += 1
    used_names.add(candidate.casefold())
    return candidate


def content_types_xml(sheet_count: int) -> str:
    overrides = [
        override_xml(
            "/xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        ),
        override_xml(
            "/xl/styles.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
        ),
    ]
    overrides.extend(
        override_xml(
            f"/xl/worksheets/sheet{index}.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        )
        for index in range(1, sheet_count + 1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Default Extension="rels" ContentType="{PACKAGE_RELATIONSHIP_CONTENT_TYPE}"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'{"".join(overrides)}'
        "</Types>"
    )


def weekly_worker_content_types_xml(*, include_logo: bool) -> str:
    overrides = [
        override_xml(
            "/xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        ),
        override_xml(
            "/xl/styles.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
        ),
        override_xml(
            "/xl/worksheets/sheet1.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        ),
        override_xml(
            "/xl/tables/table1.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
        ),
    ]
    if include_logo:
        overrides.append(
            override_xml(
                "/xl/drawings/drawing1.xml",
                "application/vnd.openxmlformats-officedocument.drawing+xml",
            )
        )
    png_default = '<Default Extension="png" ContentType="image/png"/>' if include_logo else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Default Extension="rels" ContentType="{PACKAGE_RELATIONSHIP_CONTENT_TYPE}"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'{png_default}'
        f'{"".join(overrides)}'
        '</Types>'
    )


def package_relationships_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{relationship_xml("rId1", "officeDocument", "xl/workbook.xml")}'
        "</Relationships>"
    )


def workbook_relationships_xml(sheet_count: int) -> str:
    relationships = [
        relationship_xml(f"rId{index}", "worksheet", f"worksheets/sheet{index}.xml")
        for index in range(1, sheet_count + 1)
    ]
    relationships.append(
        relationship_xml(f"rId{sheet_count + 1}", "styles", "styles.xml")
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(relationships)}'
        "</Relationships>"
    )


def weekly_worker_sheet_relationships_xml(*, include_logo: bool) -> str:
    relationships: list[str] = []
    if include_logo:
        relationships.append(relationship_xml("rId1", "drawing", "../drawings/drawing1.xml"))
        relationships.append(relationship_xml("rId2", "table", "../tables/table1.xml"))
    else:
        relationships.append(relationship_xml("rId1", "table", "../tables/table1.xml"))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(relationships)}'
        '</Relationships>'
    )


def weekly_worker_drawing_relationships_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{relationship_xml("rId1", "image", "../media/beg_logo_icon.png")}'
        '</Relationships>'
    )


def workbook_xml(sheets: list[dict[str, object]]) -> str:
    sheet_nodes = [
        f'<sheet name="{xml_escape(str(sheet["name"]))}" sheetId="{index}" r:id="rId{index}"/>'
        for index, sheet in enumerate(sheets, start=1)
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(sheet_nodes)}</sheets>'
        "</workbook>"
    )


def weekly_worker_workbook_xml(sheet_name: str) -> str:
    print_title_sheet = excel_formula_sheet_name(sheet_name)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets>'
        f'<sheet name="{xml_escape(sheet_name)}" sheetId="1" r:id="rId1"/>'
        '</sheets>'
        '<definedNames>'
        f'<definedName name="_xlnm.Print_Titles" localSheetId="0">'
        f"{xml_escape(print_title_sheet)}!$8:$8"
        '</definedName>'
        '</definedNames>'
        '</workbook>'
    )


def weekly_worker_worksheet_xml(
    *,
    person_name: str,
    week_number: int,
    year: int,
    start: date,
    end: date,
    data_values: list[list[object]],
    table_last_row: int,
    include_logo: bool,
) -> str:
    row_nodes = [
        worksheet_row_xml(1, ["Lohnprüfung Monteurwoche"], [1], height=34),
        worksheet_row_xml(2, [""], [8], height=5),
        worksheet_row_xml(3, ["Monteur:", person_name], [2, 3], height=20),
        worksheet_row_xml(4, ["Kalenderwoche:", f"KW {week_number:02d}/{year}"], [2, 3], height=20),
        worksheet_row_xml(5, ["Zeitraum:", f"{start.strftime('%d.%m.%Y')} bis {end.strftime('%d.%m.%Y')}"], [2, 3], height=20),
        worksheet_row_xml(6, ["Exportdatum:", date.today().strftime("%d.%m.%Y")], [2, 3], height=20),
        worksheet_row_xml(
            WEEKLY_WORKER_HEADER_ROW_INDEX,
            WEEKLY_WORKER_HEADERS,
            [4] * len(WEEKLY_WORKER_HEADERS),
            height=24,
        ),
    ]
    for offset, values in enumerate(data_values):
        row_index = WEEKLY_WORKER_DATA_START_ROW_INDEX + offset
        row_nodes.append(
            worksheet_row_xml(
                row_index,
                values,
                weekly_worker_data_style_ids(),
                height=32,
            )
        )

    drawing_node = '<drawing r:id="rId1"/>' if include_logo else ""
    table_relationship_id = "rId2" if include_logo else "rId1"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
        f'<dimension ref="A1:L{table_last_row}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="8" topLeftCell="A9" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft"/>'
        '</sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f'{columns_xml(WEEKLY_WORKER_COLUMN_WIDTHS)}'
        f'<sheetData>{"".join(row_nodes)}</sheetData>'
        '<mergeCells count="6">'
        '<mergeCell ref="A1:H1"/>'
        '<mergeCell ref="B3:D3"/>'
        '<mergeCell ref="B4:D4"/>'
        '<mergeCell ref="B5:D5"/>'
        '<mergeCell ref="B6:D6"/>'
        '<mergeCell ref="J1:L6"/>'
        '</mergeCells>'
        '<pageMargins left="0.35" right="0.35" top="0.45" bottom="0.45" header="0.2" footer="0.2"/>'
        '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
        f'{drawing_node}'
        f'<tableParts count="1"><tablePart r:id="{table_relationship_id}"/></tableParts>'
        '</worksheet>'
    )


def worksheet_row_xml(
    row_index: int,
    values: list[object],
    style_ids: list[int],
    *,
    height: int | None = None,
) -> str:
    height_attributes = f' ht="{height}" customHeight="1"' if height else ""
    cells = [
        worksheet_cell_xml(column_index, row_index, value, style_id=style_ids[column_index - 1])
        for column_index, value in enumerate(values, start=1)
    ]
    return f'<row r="{row_index}"{height_attributes}>{"".join(cells)}</row>'


def worksheet_cell_xml(column_index: int, row_index: int, value: object, *, style_id: int) -> str:
    reference = cell_reference(column_index, row_index)
    if isinstance(value, date):
        return f'<c r="{reference}" s="{style_id}"><v>{excel_date_serial(value)}</v></c>'
    return inline_string_cell(column_index, row_index, str(value), style_id=style_id)


def weekly_worker_data_style_ids() -> list[int]:
    return [5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 7, 7]


def worksheet_xml(rows: list[list[str]], column_widths: list[int]) -> str:
    row_nodes = []
    for row_index, values in enumerate(rows, start=1):
        cells = [
            inline_string_cell(column_index, row_index, value, style_id=1 if row_index == 1 else 0)
            for column_index, value in enumerate(values, start=1)
        ]
        row_nodes.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"{columns_xml(column_widths)}"
        f'<sheetData>{"".join(row_nodes)}</sheetData>'
        "</worksheet>"
    )


def columns_xml(column_widths: list[int]) -> str:
    columns = [
        f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
        for index, width in enumerate(column_widths, start=1)
    ]
    return f"<cols>{''.join(columns)}</cols>"


def inline_string_cell(column_index: int, row_index: int, value: str, *, style_id: int = 0) -> str:
    style_attribute = f' s="{style_id}"' if style_id else ""
    return (
        f'<c r="{cell_reference(column_index, row_index)}" t="inlineStr"{style_attribute}>'
        f"<is><t>{xml_escape(value)}</t></is>"
        "</c>"
    )


def weekly_worker_table_xml(table_last_row: int) -> str:
    table_ref = f"A{WEEKLY_WORKER_HEADER_ROW_INDEX}:L{table_last_row}"
    columns = "".join(
        f'<tableColumn id="{index}" name="{xml_escape(header)}"/>'
        for index, header in enumerate(WEEKLY_WORKER_HEADERS, start=1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'id="1" name="{WEEKLY_WORKER_TABLE_NAME}" displayName="{WEEKLY_WORKER_TABLE_NAME}" '
        f'ref="{table_ref}" totalsRowShown="0">'
        f'<autoFilter ref="{table_ref}"/>'
        f'<tableColumns count="{len(WEEKLY_WORKER_HEADERS)}">{columns}</tableColumns>'
        '<tableStyleInfo name="TableStyleLight9" showFirstColumn="0" showLastColumn="0" '
        'showRowStripes="1" showColumnStripes="0"/>'
        '</table>'
    )


def weekly_worker_drawing_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<xdr:oneCellAnchor>'
        '<xdr:from><xdr:col>10</xdr:col><xdr:colOff>220000</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>110000</xdr:rowOff></xdr:from>'
        '<xdr:ext cx="920000" cy="920000"/>'
        '<xdr:pic>'
        '<xdr:nvPicPr><xdr:cNvPr id="1" name="BEG Logo"/><xdr:cNvPicPr/></xdr:nvPicPr>'
        '<xdr:blipFill>'
        '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>'
        '<a:stretch><a:fillRect/></a:stretch>'
        '</xdr:blipFill>'
        '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
        '</xdr:pic>'
        '<xdr:clientData/>'
        '</xdr:oneCellAnchor>'
        '</xdr:wsDr>'
    )


def cell_reference(column_index: int, row_index: int) -> str:
    letters = ""
    value = column_index
    while value:
        value, remainder = divmod(value - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row_index}"


def excel_formula_sheet_name(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def weekly_worker_styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yy"/></numFmts>'
        '<fonts count="5">'
        '<font><sz val="10"/><color rgb="FF172033"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="18"/><color rgb="FF172033"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="10"/><color rgb="FF475569"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="10"/><color rgb="FF243348"/><name val="Calibri"/><family val="2"/></font>'
        '<font><sz val="10"/><color rgb="FF172033"/><name val="Calibri"/><family val="2"/></font>'
        '</fonts>'
        '<fills count="4">'
        '<fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill>'
        '</fills>'
        '<borders count="4">'
        '<border/>'
        '<border><bottom style="thin"><color rgb="FFD7E1EE"/></bottom></border>'
        '<border><left style="thin"><color rgb="FFE2E8F0"/></left>'
        '<right style="thin"><color rgb="FFE2E8F0"/></right>'
        '<top style="thin"><color rgb="FFE2E8F0"/></top>'
        '<bottom style="thin"><color rgb="FFE2E8F0"/></bottom></border>'
        '<border><left style="thin"><color rgb="FFD7E1EE"/></left>'
        '<right style="thin"><color rgb="FFD7E1EE"/></right>'
        '<top style="thin"><color rgb="FFD7E1EE"/></top>'
        '<bottom style="thin"><color rgb="FFD7E1EE"/></bottom></border>'
        '</borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="9">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="2" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="4" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="3" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1">'
        '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1">'
        '<alignment vertical="center" wrapText="1"/></xf>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1">'
        '<alignment vertical="center"/></xf>'
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1">'
        '<alignment vertical="center" wrapText="1"/></xf>'
        '<xf numFmtId="0" fontId="0" fillId="2" borderId="3" xfId="0" applyFill="1" applyBorder="1"/>'
        '</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>'
    )


def styles_xml() -> str:
    header_fill = (
        '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF4F9"/>'
        '<bgColor indexed="64"/></patternFill></fill>'
    )
    thin_border = (
        '<border><left style="thin"><color rgb="FFE2E8F0"/></left>'
        '<right style="thin"><color rgb="FFE2E8F0"/></right>'
        '<top style="thin"><color rgb="FFE2E8F0"/></top>'
        '<bottom style="thin"><color rgb="FFE2E8F0"/></bottom></border>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2">'
        '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'
        '<font><b/><sz val="11"/><color rgb="FF172033"/>'
        '<name val="Calibri"/><family val="2"/></font>'
        "</fonts>"
        f'<fills count="2"><fill><patternFill patternType="none"/></fill>{header_fill}</fills>'
        f'<borders count="2"><border/>{thin_border}</borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" '
        'fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" '
        'applyFont="1" applyFill="1" applyBorder="1"/>'
        "</cellXfs>"
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def xml_escape(value: str | int | None) -> str:
    if value is None:
        return ""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def override_xml(part_name: str, content_type: str) -> str:
    return f'<Override PartName="{part_name}" ContentType="{content_type}"/>'


def relationship_xml(relationship_id: str, relationship_type: str, target: str) -> str:
    return (
        f'<Relationship Id="{relationship_id}" '
        f'Type="{OFFICE_DOCUMENT_RELATIONSHIP_BASE}/{relationship_type}" '
        f'Target="{target}"/>'
    )
