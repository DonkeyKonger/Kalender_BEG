from datetime import date
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.services.payroll_month_xlsx_service import build_payroll_month_xlsx
from app.tests.test_payroll_month_absences import absence
from app.tests.test_payroll_month_xlsx_service import (
    NS,
    assert_ignorable_namespaces_are_declared,
    cell_number_format,
    cell_text,
    make_entry,
)


def export_month(records=(), *, year=2026, month=8, holidays=(), weekly_hours=40, entries=()):
    result = build_payroll_month_xlsx(
        person=Person(id=1, display_name="Test Monteur", weekly_hours=weekly_hours),
        year=year, month=month, entries=entries,
        absences=records, non_working_dates=holidays,
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        assert workbook.testzip() is None
        sheet_xml = workbook.read("xl/worksheets/sheet1.xml")
        styles_xml = workbook.read("xl/styles.xml")
    assert_ignorable_namespaces_are_declared(sheet_xml)
    assert_ignorable_namespaces_are_declared(styles_xml)
    return ET.fromstring(sheet_xml), ET.fromstring(styles_xml)


def test_three_sick_days_show_24_hours_and_reduce_168_normal_hours_to_144():
    sheet, styles = export_month(
        [absence(AbsenceType.SICK, date(2026, 8, 3), date(2026, 8, 5)),
         absence(AbsenceType.VACATION, date(2026, 8, 7))],
        entries=[make_entry(1, date(2026, 8, 6), "06:00", "14:30", None)],
    )

    assert cell_text(sheet, "D48") == "3"
    assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(24)
    assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(144)
    assert float(cell_text(sheet, "E41")) * 24 == pytest.approx(16.5)
    assert cell_text(sheet, "D47") == "-127:30"
    # Der Abzug bleibt in der bestehenden Normalstundenformel nachvollziehbar.
    assert sheet.find('.//main:c[@r="G48"]/main:f', NS).text == "D48*8/24"
    assert sheet.find('.//main:c[@r="D46"]/main:f', NS).text == (
        "ROUND(40/5*21*60,0)/1440-G48"
    )
    assert "E41-D46" in sheet.find('.//main:c[@r="D47"]/main:f', NS).text
    assert cell_number_format(sheet, styles, "G48") == "[h]:mm"
    # Krankheit bleibt in der Tages- und Gesamtsumme bei null Stunden.
    for row in (12, 13, 14):
        assert cell_text(sheet, f"H{row}") == "Krankheit"
        assert float(cell_text(sheet, f"E{row}")) == 0
    assert float(cell_text(sheet, "E16")) * 24 == pytest.approx(8)


@pytest.mark.parametrize(("start", "end", "count"), [
    (date(2026, 7, 30), date(2026, 8, 4), 2),
    (date(2026, 8, 28), date(2026, 9, 2), 2),
    (date(2026, 7, 1), date(2026, 7, 31), 0),
    (date(2026, 8, 8), date(2026, 8, 9), 0),
    (date(2026, 8, 1), date(2026, 8, 31), 21),
])
def test_sick_summary_counts_only_weekdays_in_selected_month(start, end, count):
    sheet, _ = export_month([absence(AbsenceType.SICK, start, end)])
    assert int(cell_text(sheet, "D48")) == count
    assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(count * 8)
    assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(168 - count * 8)
    assert float(cell_text(sheet, "E41")) == 0
    if count == 21:
        assert float(cell_text(sheet, "D47")) == 0


def test_public_holidays_are_not_subtracted_twice_as_sick_days():
    sheet, _ = export_month(
        [absence(AbsenceType.SICK, date(2026, 4, 2), date(2026, 4, 7))],
        month=4, holidays={date(2026, 4, 3), date(2026, 4, 6)},
    )
    assert cell_text(sheet, "D48") == "2"
    assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(16)
    assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(144)  # 160 - 16


def test_sick_summary_deduplicates_dates_and_ignores_foreign_cancelled_and_other_absences():
    sheet, _ = export_month([
        absence(AbsenceType.SICK, date(2026, 8, 3), date(2026, 8, 5)),
        absence(AbsenceType.SICK, date(2026, 8, 4)),
        absence(AbsenceType.SICK, date(2026, 8, 6), status=AbsenceStatus.CANCELLED),
        absence(AbsenceType.SICK, date(2026, 8, 7), person_id=2),
        absence(AbsenceType.VACATION, date(2026, 8, 10)),
        absence(AbsenceType.OTHER, date(2026, 8, 11)),
    ])
    assert cell_text(sheet, "D48") == "3"
    assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(24)
    assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(144)


def test_no_sick_days_leaves_normal_hours_unchanged():
    sheet, _ = export_month()
    assert cell_text(sheet, "D48") == "0"
    assert float(cell_text(sheet, "G48")) == 0
    assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(168)


def test_missing_weekly_hours_still_shows_sick_summary_without_inventing_normal_hours():
    sheet, _ = export_month(
        [absence(AbsenceType.SICK, date(2026, 8, 3), date(2026, 8, 5))],
        weekly_hours=None,
    )
    assert cell_text(sheet, "D48") == "3"
    assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(24)
    assert cell_text(sheet, "D46") == cell_text(sheet, "D47") == "–"
