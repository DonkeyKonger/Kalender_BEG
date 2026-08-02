from datetime import date, time
from io import BytesIO
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest

from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.services.time_entry_xlsx_export_service import (
    WeeklyWorkerSheet,
    build_weekly_workers_xlsx,
    build_weekly_worker_xlsx,
    excel_date_serial,
    unique_weekly_worker_sheet_names,
    weekly_worker_entry_has_hours,
    weekly_worker_break_minutes,
    weekly_worker_rows,
    weekly_worker_total_minutes,
    weekly_worker_work_minutes,
)


NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def test_weekly_worker_xlsx_fills_master_template_with_checked_values():
    entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=time(6, 30),
        end_time=time(15, 30),
        break_minutes=30,
        work_minutes=510,
        travel_minutes=30,
        payroll_corrected_start_time=time(7, 30),
        payroll_corrected_end_time=time(15, 30),
        payroll_corrected_work_minutes=480,
        source="manual",
    )
    entry.site = Site(site_number="8008", name="Friedensschule Osnabrück")
    friday_entry = WorkTimeEntry(
        work_date=date(2026, 6, 12),
        start_time=time(7, 0),
        end_time=time(16, 0),
        break_minutes=60,
        work_minutes=0,
        travel_minutes=0,
        source="manual",
    )
    friday_entry.site = Site(site_number="1000", name="Büsum")

    content = build_weekly_worker_xlsx(
        person_name="Christopher Erichsen",
        week_number=24,
        year=2026,
        start=date(2026, 6, 8),
        end=date(2026, 6, 14),
        rows=weekly_worker_rows(
            date(2026, 6, 8),
            date(2026, 6, 14),
            [entry, friday_entry],
            {},
        ),
    )

    workbook, sheet = workbook_sheet(content)
    names = set(workbook.namelist())
    sheet_xml = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
    workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")

    assert "xl/tables/table1.xml" not in names
    assert "xl/media/image1.png" in names
    assert 'mc:Ignorable="x14ac xr xr2 xr3"' in sheet_xml
    assert 'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2"' in sheet_xml
    assert 'xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3"' in sheet_xml
    assert "'Tabelle1'!$A$1:$O$29" in workbook_xml
    assert sheet.find("main:sheetPr/main:pageSetUpPr", NS).attrib["fitToPage"] == "1"
    page_setup = sheet.find("main:pageSetup", NS)
    assert page_setup.attrib["fitToWidth"] == "1"
    assert page_setup.attrib["fitToHeight"] == "1"
    assert cell_text(sheet, "C5") == "08.06.2026"
    assert cell_text(sheet, "E5") == "14.06.2026"
    assert cell_text(sheet, "H5") == "24"
    assert cell_text(sheet, "B7") == "Christopher Erichsen"
    assert cell_text(sheet, "A15") == "Mo"
    assert cell_number(sheet, "B15") == excel_date_serial(date(2026, 6, 8))
    assert cell_text(sheet, "C15") == "8008 - Friedensschule Osnabrück"
    assert cell_number(sheet, "J15") == pytest.approx(7.5 / 24)
    assert cell_number(sheet, "K15") == pytest.approx(15.5 / 24)
    assert cell_number(sheet, "L15") == 0.5
    assert cell_text(sheet, "O15") == "8,50 h"
    assert cell_text(sheet, "A16") == "Di"
    assert cell_text(sheet, "C16") == "Keine Zeitmeldung"
    assert cell_text(sheet, "A19") == "Fr"
    assert cell_text(sheet, "C19") == "1000 - Büsum"
    assert cell_style(sheet, "J19") == "7"
    assert cell_style(sheet, "K19") == "7"
    assert cell_number(sheet, "J19") == pytest.approx(7 / 24)
    assert cell_number(sheet, "K19") == pytest.approx(16 / 24)
    assert cell_text(sheet, "O19") == "8,00 h"
    assert cell_text(sheet, "A20") == ""
    assert cell_text(sheet, "C20") == ""
    assert cell_text(sheet, "O26") == "16,50 h"


def test_weekly_worker_xlsx_extends_template_rows_when_week_has_many_entries():
    entries = []
    for index in range(11):
        entry = WorkTimeEntry(
            work_date=date(2026, 6, 8),
            start_time=time(7, 0),
            end_time=time(8, 0),
            break_minutes=0,
            work_minutes=60,
            travel_minutes=0,
            source="manual",
        )
        entry.site = Site(site_number=f"80{index:02d}", name=f"Baustelle {index}")
        entries.append(entry)

    content = build_weekly_worker_xlsx(
        person_name="Viele Einträge",
        week_number=24,
        year=2026,
        start=date(2026, 6, 8),
        end=date(2026, 6, 14),
        rows=weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), entries, {}),
    )

    workbook, sheet = workbook_sheet(content)
    workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")

    assert sheet.find("main:dimension", NS).attrib["ref"] == "A1:O37"
    assert cell_text(sheet, "C25") == "8010 - Baustelle 10"
    assert cell_text(sheet, "C26") == "Keine Zeitmeldung"
    assert cell_text(sheet, "O31") == "11,00 h"
    assert "'Tabelle1'!$A$1:$O$34" in workbook_xml
    merge_refs = {
        merge.attrib["ref"]
        for merge in sheet.findall("main:mergeCells/main:mergeCell", NS)
    }
    assert "C25:F25" in merge_refs
    assert "G25:I25" in merge_refs
    assert "L31:N31" in merge_refs


def test_weekly_worker_xlsx_uses_office_corrected_break_and_derived_hours():
    entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=time(7, 0),
        end_time=time(17, 0),
        break_minutes=30,
        work_minutes=570,
        travel_minutes=0,
        payroll_corrected_start_time=time(7, 0),
        payroll_corrected_end_time=time(17, 0),
        payroll_corrected_break_minutes=60,
        payroll_corrected_work_minutes=None,
        source="manual",
    )
    entry.site = Site(site_number="8008", name="Friedensschule Osnabrück")
    rows = weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), [entry], {})

    content = build_weekly_worker_xlsx(
        person_name="Christopher Erichsen",
        week_number=24,
        year=2026,
        start=date(2026, 6, 8),
        end=date(2026, 6, 14),
        rows=rows,
    )
    _, sheet = workbook_sheet(content)

    assert weekly_worker_break_minutes(entry) == 60
    assert weekly_worker_work_minutes(entry) == 540
    assert weekly_worker_total_minutes(rows[0]) == 540
    assert cell_number(sheet, "L15") == 1
    assert cell_text(sheet, "O15") == "9,00 h"


def test_weekly_workers_xlsx_creates_one_template_sheet_per_worker():
    erichsen_entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=time(7, 0),
        end_time=time(15, 0),
        break_minutes=30,
        work_minutes=450,
        travel_minutes=0,
        source="manual",
    )
    erichsen_entry.site = Site(site_number="8008", name="Friedensschule Osnabrück")
    kramer_entry = WorkTimeEntry(
        work_date=date(2026, 6, 9),
        start_time=time(8, 0),
        end_time=time(12, 0),
        break_minutes=0,
        work_minutes=240,
        travel_minutes=0,
        source="manual",
    )
    kramer_entry.site = Site(site_number="4630", name="Neubau Volksbank Lathen")

    content = build_weekly_workers_xlsx([
        WeeklyWorkerSheet(
            person_name="Christopher Erichsen",
            sheet_name="Erichsen",
            week_number=24,
            year=2026,
            start=date(2026, 6, 8),
            end=date(2026, 6, 14),
            rows=weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), [erichsen_entry], {}),
        ),
        WeeklyWorkerSheet(
            person_name="Christoph Kramer",
            sheet_name="Kramer",
            week_number=24,
            year=2026,
            start=date(2026, 6, 8),
            end=date(2026, 6, 14),
            rows=weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), [kramer_entry], {}),
        ),
    ])

    workbook = ZipFile(BytesIO(content))
    names = set(workbook.namelist())
    workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
    workbook_relationships = workbook.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    content_types = workbook.read("[Content_Types].xml").decode("utf-8")
    first_sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    second_sheet = ET.fromstring(workbook.read("xl/worksheets/sheet2.xml"))

    assert "xl/worksheets/sheet1.xml" in names
    assert "xl/worksheets/sheet2.xml" in names
    assert "xl/drawings/drawing1.xml" in names
    assert "xl/drawings/drawing2.xml" in names
    assert 'name="Erichsen" sheetId="1" r:id="rIdSheet1"' in workbook_xml
    assert 'name="Kramer" sheetId="2" r:id="rIdSheet2"' in workbook_xml
    assert "'Erichsen'!$A$1:$O$29" in workbook_xml
    assert "'Kramer'!$A$1:$O$29" in workbook_xml
    assert 'Target="worksheets/sheet1.xml"' in workbook_relationships
    assert 'Target="worksheets/sheet2.xml"' in workbook_relationships
    assert "/xl/worksheets/sheet2.xml" in content_types
    assert "/xl/drawings/drawing2.xml" in content_types
    assert cell_text(first_sheet, "B7") == "Christopher Erichsen"
    assert cell_text(first_sheet, "C15") == "8008 - Friedensschule Osnabrück"
    assert cell_text(second_sheet, "B7") == "Christoph Kramer"
    assert cell_text(second_sheet, "C16") == "4630 - Neubau Volksbank Lathen"


def test_weekly_worker_rows_skip_empty_weekends_but_keep_worked_weekends():
    sunday_entry = WorkTimeEntry(
        work_date=date(2026, 6, 14),
        start_time=time(8, 0),
        end_time=time(12, 0),
        break_minutes=0,
        work_minutes=240,
        travel_minutes=0,
        source="manual",
    )
    sunday_entry.site = Site(site_number="9000", name="Notdienst")

    rows = weekly_worker_rows(
        date(2026, 6, 8),
        date(2026, 6, 14),
        [sunday_entry],
        {},
    )

    assert [row.work_date for row in rows] == [
        date(2026, 6, 8),
        date(2026, 6, 9),
        date(2026, 6, 10),
        date(2026, 6, 11),
        date(2026, 6, 12),
        date(2026, 6, 14),
    ]
    assert rows[-1].entry is sunday_entry


def test_weekly_worker_hours_filter_and_sheet_names():
    blank_entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=None,
        end_time=None,
        break_minutes=0,
        work_minutes=0,
        travel_minutes=0,
        source="manual",
    )
    office_entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=None,
        end_time=None,
        break_minutes=0,
        work_minutes=0,
        travel_minutes=0,
        payroll_corrected_start_time=time(8, 0),
        payroll_corrected_end_time=time(12, 0),
        source="manual",
    )

    assert not weekly_worker_entry_has_hours(blank_entry)
    assert weekly_worker_entry_has_hours(office_entry)
    assert unique_weekly_worker_sheet_names([
        "Christopher Erichsen",
        "Test Erichsen",
        "Christoph Kramer",
    ]) == ["Erichsen", "Erichsen 2", "Kramer"]


def test_weekly_worker_travel_only_entry_counts_once():
    travel_entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=time(6, 30),
        end_time=time(7, 15),
        break_minutes=0,
        work_minutes=0,
        travel_minutes=45,
        source="manual",
    )
    row = weekly_worker_rows(
        date(2026, 6, 8),
        date(2026, 6, 14),
        [travel_entry],
        {},
    )[0]

    assert weekly_worker_entry_has_hours(travel_entry)
    assert weekly_worker_work_minutes(travel_entry) == 0
    assert weekly_worker_total_minutes(row) == 45


def test_weekly_worker_total_minutes_rounds_to_quarter_hours():
    entry = WorkTimeEntry(
        work_date=date(2026, 6, 8),
        start_time=time(7, 0),
        end_time=time(15, 11),
        break_minutes=30,
        work_minutes=461,
        travel_minutes=0,
        source="manual",
    )
    row = weekly_worker_rows(
        date(2026, 6, 8),
        date(2026, 6, 14),
        [entry],
        {},
    )[0]

    assert weekly_worker_total_minutes(row) == 465


def workbook_sheet(content: bytes):
    workbook = ZipFile(BytesIO(content))
    sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    return workbook, sheet


def cell(sheet: ET.Element, ref: str) -> ET.Element:
    found = sheet.find(f".//main:c[@r='{ref}']", NS)
    assert found is not None, ref
    return found


def cell_text(sheet: ET.Element, ref: str) -> str:
    item = cell(sheet, ref)
    text = item.find("main:is/main:t", NS)
    return text.text if text is not None and text.text is not None else ""


def cell_number(sheet: ET.Element, ref: str) -> float:
    value = cell(sheet, ref).find("main:v", NS)
    assert value is not None
    return float(value.text)


def cell_style(sheet: ET.Element, ref: str) -> str | None:
    return cell(sheet, ref).attrib.get("s")
