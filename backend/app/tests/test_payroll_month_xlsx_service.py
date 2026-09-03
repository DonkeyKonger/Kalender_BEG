from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import date, time
from io import BytesIO
from zipfile import ZipFile

import pytest

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, AbsenceType, OvernightStatus
from app.models.person import Person
from app.models.person_work_day import PersonWorkDay
from app.models.site import Site
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_xlsx_service import (
    PAYROLL_MONTH_TEMPLATE_LAYOUT,
    PayrollMonthSheet,
    build_payroll_month_plan,
    build_payroll_months_xlsx,
    build_payroll_month_xlsx,
)
from app.services.payroll_xlsx_template import load_payroll_monthly_template


NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
PERSON = Person(
    id=1,
    first_name="Erika",
    last_name="Monteurin",
    display_name="Erika Monteurin",
    short_code="EM",
)


def test_normal_workday_uses_its_single_cost_center():
    site = make_site(1, "4711", "Rathaus", street="Markt", house_number="1", city="Achim")
    entry = make_entry(1, date(2026, 6, 8), "06:00", "15:00", site, break_minutes=30)

    day = only_day([entry])

    assert day.start_time == time(6, 0)
    assert day.end_time == time(15, 0)
    assert day.break_minutes == 30
    assert day.net_work_minutes == 510
    assert day.commission_number == "4711"
    assert day.site_name == "Rathaus"
    assert day.site_address == "Markt 1, Achim"
    assert day.site_place == "Achim"
    assert day.is_derived is False


def test_multiple_cost_centers_use_the_one_with_most_recorded_duration():
    shorter = make_site(1, "1000", "Kurz", address="Kurze Straße 1", city="Bremen")
    longer = make_site(2, "2000", "Lang", address="Lange Straße 2", city="Hamburg")
    entries = [
        make_entry(1, date(2026, 6, 8), "06:00", "10:00", shorter),
        make_entry(2, date(2026, 6, 8), "10:00", "15:00", longer),
    ]

    day = only_day(entries)

    assert day.commission_number == "2000"
    assert day.site_name == "Lang"
    assert day.site_address == "Hamburg"
    assert day.site_place == "Hamburg"


def test_original_site_fills_place_when_current_site_is_missing():
    original_site = make_site(1, "4711", "Altbestand", city="Jheringsfehn")
    entry = make_entry(1, date(2026, 6, 8), "06:00", "15:00", None)
    entry.original_site_id = original_site.id
    entry.original_site = original_site

    day = only_day([entry])

    assert day.commission_number == "4711"
    assert day.site_place == "Jheringsfehn"


def test_assignment_site_fills_place_when_entry_has_no_direct_site():
    assignment_site = make_site(2, "5822", "Auftrag", city="Bad Zwischenahn")
    entry = make_entry(1, date(2026, 6, 8), "06:00", "15:00", None)
    entry.assignment_id = 7
    entry.assignment = Assignment(
        id=7,
        site_id=assignment_site.id,
        person_id=PERSON.id,
        start_date=date(2026, 6, 8),
        end_date=date(2026, 6, 8),
        site=assignment_site,
    )

    day = only_day([entry])

    assert day.commission_number == "5822"
    assert day.site_place == "Bad Zwischenahn"


def test_legacy_manual_site_note_fills_place_without_a_site_link():
    entry = make_entry(1, date(2026, 6, 8), "06:00", "15:00", None)
    entry.note = "Manuelle Baustelle: Markt 1, 28832 Achim"

    day = only_day([entry])

    assert day.commission_number is None
    assert day.site_place == "Achim"


def test_linked_site_takes_priority_over_longer_manual_site_note():
    linked_site = make_site(1, "4719", "Combi Apen", city="Apen")
    linked_entry = make_entry(
        1,
        date(2026, 6, 8),
        "06:00",
        "07:00",
        linked_site,
    )
    manual_entry = make_entry(2, date(2026, 6, 8), "07:00", "15:00", None)
    manual_entry.note = "Manuelle Baustelle: Firma Material laden / Fototermin"

    day = only_day([linked_entry, manual_entry])

    assert day.commission_number == "4719"
    assert day.site_name == "Combi Apen"
    assert day.site_place == "Apen"


def test_equal_cost_center_durations_use_the_chronologically_last_entry():
    first = make_site(1, "1000", "Früh", address="Frühweg 1")
    last = make_site(2, "2000", "Spät", address="Spätweg 2")
    entries = [
        make_entry(1, date(2026, 6, 8), "06:00", "10:00", first),
        make_entry(2, date(2026, 6, 8), "10:00", "14:00", last),
    ]

    assert only_day(entries).commission_number == "2000"


def test_day_span_uses_earliest_start_and_latest_end_across_categories():
    travel_site = make_site(1, "1000", "Anfahrt")
    work_site = make_site(2, "2000", "Baustelle")
    entries = [
        make_entry(1, date(2026, 6, 8), "05:30", "06:30", travel_site, source="travel"),
        make_entry(2, date(2026, 6, 8), "06:30", "15:00", work_site, source="manual"),
    ]

    day = only_day(entries)

    assert day.start_time == time(5, 30)
    assert day.end_time == time(15, 0)
    assert day.net_work_minutes == 570


def test_day_boundaries_are_rounded_mathematically_to_quarter_hours():
    site = make_site(1, "1000", "Baustelle")
    day = only_day([make_entry(1, date(2026, 6, 8), "05:07", "15:08", site)])

    assert day.start_time == time(5, 0)
    assert day.end_time == time(15, 15)


def test_explicit_breaks_are_preserved_but_unrecorded_gaps_are_not_work():
    site = make_site(1, "1000", "Baustelle")
    entries = [
        make_entry(1, date(2026, 6, 8), "06:00", "10:00", site, break_minutes=15),
        make_entry(2, date(2026, 6, 8), "11:00", "15:00", site, break_minutes=30),
    ]

    day = only_day(entries)

    assert day.break_minutes == 45
    assert day.net_work_minutes == 435


def test_existing_overnight_status_is_transferred_once_per_day():
    site = make_site(1, "1000", "Baustelle")
    entry = make_entry(
        1,
        date(2026, 6, 8),
        "06:00",
        "15:00",
        site,
        overnight_status=OvernightStatus.BEG_PAID,
    )

    assert only_day([entry]).overnight_status == OvernightStatus.BEG_PAID


def test_missing_overnight_status_remains_empty_in_the_day_model():
    site = make_site(1, "1000", "Baustelle")
    entry = make_entry(1, date(2026, 6, 8), "06:00", "15:00", site)

    assert only_day([entry]).overnight_status is None


def test_four_long_days_monday_to_thursday_add_friday():
    entries = long_week_entries([1, 2, 3, 4])

    plan = month_plan(entries)
    days = {day.work_date: day for day in plan.days}

    assert days[date(2026, 6, 5)].is_derived is True
    assert days[date(2026, 6, 5)].commission_number == "1004"
    assert all(days[date(2026, 6, day)].net_work_minutes == 480 for day in range(1, 6))
    assert all(days[date(2026, 6, day)].break_minutes == 45 for day in range(1, 6))


def test_four_long_days_tuesday_to_friday_add_monday_from_friday_context():
    entries = long_week_entries([2, 3, 4, 5])

    days = {day.work_date: day for day in month_plan(entries).days}
    monday = days[date(2026, 6, 1)]

    assert monday.is_derived is True
    assert monday.start_time == time(6, 0)
    assert monday.end_time == time(14, 45)
    assert monday.commission_number == "1005"


def test_four_nonconsecutive_long_weekdays_add_the_actual_missing_weekday():
    entries = long_week_entries([1, 2, 4, 5])

    days = {day.work_date: day for day in month_plan(entries).days}

    assert days[date(2026, 6, 3)].is_derived is True
    assert len([day for day in days.values() if day.is_derived]) == 1


def test_four_day_distribution_uses_week_total_even_when_one_day_is_shorter():
    entries = [
        make_entry(1, date(2026, 6, 1), "06:00", "16:15", make_site(1, "1001", "A")),
        make_entry(2, date(2026, 6, 2), "06:00", "17:00", make_site(2, "1002", "B")),
        make_entry(3, date(2026, 6, 3), "06:00", "17:45", make_site(3, "1003", "C")),
        make_entry(4, date(2026, 6, 4), "06:15", "13:15", make_site(4, "1004", "D")),
    ]

    plan = month_plan(entries)

    assert len(plan.days) == 5
    assert sum(day.net_work_minutes for day in plan.days) == 40 * 60
    assert next(day for day in plan.days if day.work_date == date(2026, 6, 5)).is_derived


def test_four_day_distribution_starts_at_exactly_36_weekly_hours():
    entries = long_week_entries([1, 2, 3, 4], end="16:00")

    plan = month_plan(entries)

    assert len(plan.days) == 5
    assert all(day.net_work_minutes == 7 * 60 + 12 for day in plan.days)
    assert sum(day.net_work_minutes for day in plan.days) == 36 * 60


def test_four_day_distribution_matches_the_review_rounding_before_distribution():
    entries = long_week_entries([1, 2, 3, 4], end="16:00")
    entries[-1].break_minutes = 59
    entries[-1].work_minutes += 1

    plan = month_plan(entries)

    assert [day.net_work_minutes for day in plan.days] == [432] * 5
    assert sum(day.net_work_minutes for day in plan.days) == 36 * 60


def test_four_day_distribution_is_not_applied_below_36_weekly_hours():
    entries = long_week_entries([1, 2, 3, 4], end="16:00")
    entries[-1].end_time = time(15, 45)
    entries[-1].work_minutes -= 15

    plan = month_plan(entries)

    assert len(plan.days) == 4
    assert not any(day.is_derived for day in plan.days)


@pytest.mark.parametrize(
    "absence_type",
    [
        AbsenceType.VACATION,
        AbsenceType.SICK,
        AbsenceType.SCHOOL,
        AbsenceType.FREE,
        AbsenceType.OTHER,
    ],
)
def test_active_absence_on_missing_day_prevents_distribution(absence_type):
    absence = Absence(
        person_id=PERSON.id,
        absence_type=absence_type,
        start_date=date(2026, 6, 5),
        end_date=date(2026, 6, 5),
        status=AbsenceStatus.ACTIVE,
    )

    plan = month_plan(long_week_entries([1, 2, 3, 4]), absences=[absence])

    work_days = [day for day in plan.days if day.absence_type is None]
    assert len(work_days) == 4
    assert all(day.net_work_minutes == 600 for day in work_days)
    if absence_type in (AbsenceType.VACATION, AbsenceType.SICK):
        assert len(plan.days) == 5
        assert plan.days[-1].absence_type == absence_type
        assert plan.days[-1].net_work_minutes == (480 if absence_type == AbsenceType.VACATION else 0)
    else:
        assert len(plan.days) == 4
    assert not any(day.is_derived for day in plan.days)


def test_non_working_date_such_as_public_holiday_prevents_distribution():
    plan = month_plan(
        long_week_entries([1, 2, 3, 4]),
        non_working_dates={date(2026, 6, 5)},
    )

    assert len(plan.days) == 4
    assert not any(day.is_derived for day in plan.days)


def test_work_above_40_hours_is_evenly_distributed_without_changing_the_total():
    entries = long_week_entries([1, 2, 3, 4], end="18:00")

    plan = month_plan(entries)

    assert sum(day.net_work_minutes for day in plan.days) == 44 * 60
    assert all(day.net_work_minutes == 8 * 60 + 48 for day in plan.days)
    assert plan.overtime_remainders == ()


def test_building_the_month_does_not_mutate_source_time_entries():
    entries = long_week_entries([1, 2, 3, 4], end="18:00")
    before = [entry_snapshot(entry) for entry in entries]

    build_payroll_month_xlsx(
        person=PERSON,
        year=2026,
        month=6,
        entries=entries,
    )

    assert [entry_snapshot(entry) for entry in entries] == before


def test_generated_workbook_opens_and_only_changes_the_template_worksheet_and_styles():
    site = make_site(
        1,
        "4711",
        "Rathaus",
        address="Markt 1, 28832 Achim",
        city="Achim",
    )
    entry = make_entry(
        1,
        date(2026, 6, 8),
        "05:07",
        "15:08",
        site,
        break_minutes=45,
        overnight_status=OvernightStatus.SELF_PAID,
    )

    result = build_payroll_month_xlsx(
        person=PERSON,
        year=2026,
        month=6,
        entries=[entry],
    )
    with (
        ZipFile(load_payroll_monthly_template()) as master,
        ZipFile(BytesIO(result.content)) as generated,
    ):
        assert generated.testzip() is None
        assert set(generated.namelist()) == set(master.namelist())
        for name in master.namelist():
            if name not in {
                PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path,
                PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path,
            }:
                assert generated.read(name) == master.read(name)
        sheet_xml = generated.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path)
        sheet = ET.fromstring(sheet_xml)
        styles_xml = generated.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path)
        styles = ET.fromstring(styles_xml)

    assert cell_text(sheet, "A17") == "8"
    assert cell_text(sheet, "C2") == "Erika Monteurin"
    assert cell_text(sheet, "C4") == "Juni 26"
    assert cell_text(sheet, "B17") == "05:00"
    assert cell_text(sheet, "C17") == "15:15"
    assert cell_text(sheet, "D17") == "0:45"
    assert float(cell_text(sheet, "E17")) == pytest.approx(555 / 1440)
    assert float(cell_text(sheet, "E41")) == pytest.approx(555 / 1440)
    assert cell_text(sheet, "F17") == "MA"
    assert cell_text(sheet, "G17") == "4711"
    assert cell_text(sheet, "H17") == "Achim"
    assert all(
        cell_shrinks_to_fit(sheet, styles, ref)
        for ref in ("H10", "H11", "H12", "H17", "H40")
    )
    assert not cell_shrinks_to_fit(sheet, styles, "I17")
    assert [formula.text for formula in sheet.findall(".//main:f", NS)] == [
        "SUM(E10:E40)", "D48*8/24",
    ]
    for ref in ("E10", "E17", "E40", "E41", "D46", "D47", "G48"):
        assert cell_number_format(sheet, styles, ref) == "[h]:mm"
    assert (
        b'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2"' in sheet_xml
    )
    assert (
        b'xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3"' in sheet_xml
    )
    assert_ignorable_namespaces_are_declared(sheet_xml)
    assert_ignorable_namespaces_are_declared(styles_xml)


def test_all_workers_workbook_clones_the_master_sheet_for_every_worker():
    second_person = Person(
        id=2,
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    first_entry = make_entry(
        1,
        date(2026, 6, 8),
        "06:00",
        "15:00",
        make_site(1, "4711", "Rathaus", address="Markt 1"),
        break_minutes=30,
    )
    second_entry = make_entry(
        2,
        date(2026, 6, 9),
        "07:00",
        "16:00",
        make_site(2, "5822", "Schule", address="Schulweg 2"),
        break_minutes=45,
    )
    second_entry.person_id = second_person.id

    result = build_payroll_months_xlsx(
        [
            PayrollMonthSheet(PERSON, PERSON.display_name, 2026, 6, [first_entry]),
            PayrollMonthSheet(second_person, second_person.display_name, 2026, 6, [second_entry]),
        ]
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        assert workbook.testzip() is None
        names = set(workbook.namelist())
        workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
        relationships = workbook.read("xl/_rels/workbook.xml.rels").decode("utf-8")
        styles_xml = workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path)
        first_sheet_xml = workbook.read("xl/worksheets/sheet1.xml")
        second_sheet_xml = workbook.read("xl/worksheets/sheet2.xml")
        first_sheet = ET.fromstring(first_sheet_xml)
        second_sheet = ET.fromstring(second_sheet_xml)

    assert "xl/worksheets/sheet2.xml" in names
    assert "xl/drawings/drawing2.xml" in names
    assert 'name="Monteurin" sheetId="1" r:id="rIdSheet1"' in workbook_xml
    assert 'name="Monteur" sheetId="2" r:id="rIdSheet2"' in workbook_xml
    assert 'Target="worksheets/sheet2.xml"' in relationships
    assert cell_text(first_sheet, "G17") == "4711"
    assert cell_text(second_sheet, "G18") == "5822"
    assert len(result.plans) == 2
    assert_ignorable_namespaces_are_declared(styles_xml)
    assert_ignorable_namespaces_are_declared(first_sheet_xml)
    assert_ignorable_namespaces_are_declared(second_sheet_xml)


@pytest.mark.parametrize(
    ("year", "month", "weekly_hours", "holidays", "normal_hours"),
    [
        (2026, 8, 40, set(), 168),
        (2026, 4, 40, {date(2026, 4, 3), date(2026, 4, 6)}, 160),
        # Feiertage am Wochenende werden nicht nochmals abgezogen.
        (2026, 10, 40, {date(2026, 10, 3), date(2026, 10, 31)}, 176),
        (2028, 2, 40, set(), 168),
        (2026, 2, 40, set(), 160),
        (2026, 8, 37.5, set(), 157.5),
        (2026, 8, 0, set(), 0),
        (2026, 8, 40, {date(2026, 7, 31), date(2026, 9, 1)}, 168),
    ],
)
def test_normal_hours_use_person_weekly_hours_and_month_weekdays_without_holidays(
    monkeypatch, year, month, weekly_hours, holidays, normal_hours
):
    monkeypatch.setattr(PERSON, "weekly_hours", weekly_hours)
    result = build_payroll_month_xlsx(
        person=PERSON, year=year, month=month, entries=[], non_working_dates=holidays,
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
    assert float(cell_text(sheet, "E41")) == 0
    assert float(cell_text(sheet, "D46")) == pytest.approx(normal_hours / 24)
    if normal_hours:
        hours, minutes = divmod(round(normal_hours * 60), 60)
        assert cell_text(sheet, "D47") == f"-{hours}:{minutes:02d}"
        assert sheet.find('.//main:c[@r="D47"]', NS).attrib["t"] == "str"
    else:
        assert float(cell_text(sheet, "D47")) == 0


def test_totals_sum_distributed_days_and_keep_positive_overtime(monkeypatch):
    monkeypatch.setattr(PERSON, "weekly_hours", 5)
    result = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=6,
        entries=long_week_entries([1, 2, 3, 4]),
    )
    assert len(result.plan.days) == 5
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
    daily_values = [
        float(cell_text(sheet, f"E{row}") or 0) for row in range(10, 41)
    ]
    assert sum(daily_values) == pytest.approx(40 / 24)
    assert float(cell_text(sheet, "E41")) == pytest.approx(sum(daily_values))
    assert float(cell_text(sheet, "D46")) == pytest.approx(22 / 24)
    assert float(cell_text(sheet, "D47")) == pytest.approx(18 / 24)
    assert sheet.find('.//main:c[@r="E41"]/main:f', NS).text == "SUM(E10:E40)"
    assert "E41-D46" in sheet.find('.//main:c[@r="D47"]/main:f', NS).text


def test_month_total_excludes_entries_outside_month(monkeypatch):
    monkeypatch.setattr(PERSON, "weekly_hours", 40)
    entries = [
        make_entry(index, work_date, "06:00", "14:30", None, break_minutes=30)
        for index, work_date in enumerate(
            (date(2026, 7, 31), date(2026, 8, 3), date(2026, 9, 1)), start=1
        )
    ]
    result = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=8, entries=entries,
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
    assert float(cell_text(sheet, "E41")) == pytest.approx(8 / 24)
    assert cell_text(sheet, "D47") == "-160:00"


def test_missing_weekly_hours_does_not_invent_a_target_or_overtime():
    result = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=8,
        entries=[make_entry(1, date(2026, 8, 3), "06:00", "14:30", None)],
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
    assert float(cell_text(sheet, "E41")) == pytest.approx(8.5 / 24)
    assert cell_text(sheet, "D46") == "–"
    assert cell_text(sheet, "D47") == "–"


@pytest.mark.parametrize(("last_day_end", "total_minutes", "overtime"), [
    ("10:30", 9870, "-3:30"),
    ("14:00", 10080, 0),
    ("14:30", 10110, 30 / 1440),
])
def test_month_totals_preserve_minutes_and_zero_balance(
    monkeypatch, last_day_end, total_minutes, overtime
):
    monkeypatch.setattr(PERSON, "weekly_hours", 40)
    weekdays = [date(2026, 8, day) for day in range(1, 32)
                if date(2026, 8, day).weekday() < 5]
    entries = [
        make_entry(index, work_date, "06:00", "14:00", None)
        for index, work_date in enumerate(weekdays[:-1], start=1)
    ]
    entries.append(make_entry(21, weekdays[-1], "06:00", last_day_end, None))
    result = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=8, entries=entries,
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read(PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path))
    assert sum(day.net_work_minutes for day in result.plan.days) == total_minutes
    assert float(cell_text(sheet, "E41")) == pytest.approx(total_minutes / 1440)
    assert float(cell_text(sheet, "D46")) == 7
    if isinstance(overtime, str):
        assert cell_text(sheet, "D47") == overtime
    else:
        assert float(cell_text(sheet, "D47")) == pytest.approx(overtime)


def only_day(entries: list[WorkTimeEntry]):
    plan = month_plan(entries)
    assert len(plan.days) == 1
    return plan.days[0]


def month_plan(
    entries: list[WorkTimeEntry],
    *,
    absences: list[Absence] | None = None,
    non_working_dates: set[date] | None = None,
):
    return build_payroll_month_plan(
        person=PERSON,
        year=2026,
        month=6,
        entries=entries,
        absences=absences or [],
        non_working_dates=non_working_dates or set(),
    )


def long_week_entries(
    days: list[int],
    *,
    end: str = "17:00",
) -> list[WorkTimeEntry]:
    return [
        make_entry(
            index,
            date(2026, 6, day),
            "06:00",
            end,
            make_site(index, f"10{day:02d}", f"Baustelle {day}", address=f"Straße {day}"),
            break_minutes=60,
        )
        for index, day in enumerate(days, start=1)
    ]


def make_site(
    site_id: int,
    number: str,
    name: str,
    *,
    address: str | None = None,
    street: str | None = None,
    house_number: str | None = None,
    postal_code: str | None = None,
    city: str | None = None,
) -> Site:
    return Site(
        id=site_id,
        site_number=number,
        name=name,
        address=address,
        street=street,
        house_number=house_number,
        postal_code=postal_code,
        city=city,
    )


def make_entry(
    entry_id: int,
    work_date: date,
    start: str,
    end: str,
    site: Site | None,
    *,
    break_minutes: int = 0,
    source: str = "manual",
    overnight_status: OvernightStatus | None = None,
) -> WorkTimeEntry:
    start_time = time.fromisoformat(start)
    end_time = time.fromisoformat(end)
    duration = (
        end_time.hour * 60 + end_time.minute - start_time.hour * 60 - start_time.minute
    ) % 1440
    entry = WorkTimeEntry(
        id=entry_id,
        person_id=PERSON.id,
        site_id=site.id if site is not None else None,
        work_date=work_date,
        start_time=start_time,
        end_time=end_time,
        break_minutes=break_minutes,
        travel_minutes=duration if source == "travel" else 0,
        work_minutes=max(0, duration - break_minutes) if source != "travel" else 0,
        source=source,
        status="submitted",
    )
    if site is not None:
        entry.site = site
    if overnight_status is not None:
        entry.__dict__["work_day"] = PersonWorkDay(
            person_id=PERSON.id,
            work_date=work_date,
            overnight_status=overnight_status.value,
        )
    return entry


def entry_snapshot(entry: WorkTimeEntry) -> tuple[object, ...]:
    return (
        entry.work_date,
        entry.start_time,
        entry.end_time,
        entry.break_minutes,
        entry.work_minutes,
        entry.payroll_corrected_start_time,
        entry.payroll_corrected_end_time,
        entry.payroll_corrected_break_minutes,
        entry.payroll_corrected_work_minutes,
        entry.site_id,
        entry.source,
    )


def cell_text(sheet: ET.Element, ref: str) -> str:
    cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
    assert cell is not None
    inline = cell.find("main:is/main:t", NS)
    if inline is not None:
        return inline.text or ""
    value = cell.find("main:v", NS)
    return "" if value is None else value.text or ""


def cell_shrinks_to_fit(sheet: ET.Element, styles: ET.Element, ref: str) -> bool:
    cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
    assert cell is not None
    style_id = int(cell.attrib.get("s", "0"))
    cell_xfs = styles.find("main:cellXfs", NS)
    assert cell_xfs is not None
    style = list(cell_xfs)[style_id]
    alignment = style.find("main:alignment", NS)
    return alignment is not None and alignment.attrib.get("shrinkToFit") == "1"


def assert_ignorable_namespaces_are_declared(document_xml: bytes) -> None:
    text = document_xml.decode("utf-8")
    ignorable_match = re.search(r'\bmc:Ignorable="([^"]+)"', text)
    assert ignorable_match is not None
    declared_prefixes = set(re.findall(r'\bxmlns:([A-Za-z_][\w.-]*)=', text))
    missing_prefixes = set(ignorable_match.group(1).split()) - declared_prefixes
    assert missing_prefixes == set()


def cell_number_format(sheet: ET.Element, styles: ET.Element, ref: str) -> str:
    cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
    style = styles.find("main:cellXfs", NS)[int(cell.attrib["s"])]
    format_id = style.attrib["numFmtId"]
    return styles.find(f'main:numFmts/main:numFmt[@numFmtId="{format_id}"]', NS).attrib[
        "formatCode"
    ]
