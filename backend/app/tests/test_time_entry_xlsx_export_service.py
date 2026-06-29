from datetime import date, time
from io import BytesIO
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest

from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.services.time_entry_xlsx_export_service import (
    build_weekly_worker_xlsx,
    excel_date_serial,
    weekly_worker_rows,
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

    content = build_weekly_worker_xlsx(
        person_name="Christopher Erichsen",
        week_number=24,
        year=2026,
        start=date(2026, 6, 8),
        end=date(2026, 6, 14),
        rows=weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), [entry], {}),
    )

    workbook, sheet = workbook_sheet(content)
    names = set(workbook.namelist())

    assert "xl/tables/table1.xml" not in names
    assert "xl/media/image1.png" in names
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
    assert cell_text(sheet, "O15") == "8,5 h"
    assert cell_text(sheet, "A16") == "Di"
    assert cell_text(sheet, "C16") == "Keine Zeitmeldung"
    assert cell_text(sheet, "O26") == "8,5 h"


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

    _workbook, sheet = workbook_sheet(content)

    assert sheet.find("main:dimension", NS).attrib["ref"] == "A1:O39"
    assert cell_text(sheet, "C25") == "8010 - Baustelle 10"
    assert cell_text(sheet, "C26") == "Keine Zeitmeldung"
    assert cell_text(sheet, "O33") == "11,0 h"
    merge_refs = {
        merge.attrib["ref"]
        for merge in sheet.findall("main:mergeCells/main:mergeCell", NS)
    }
    assert "C25:F25" in merge_refs
    assert "G25:I25" in merge_refs
    assert "L33:N33" in merge_refs


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
