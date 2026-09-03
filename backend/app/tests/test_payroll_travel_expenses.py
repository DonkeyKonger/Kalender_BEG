from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date, time, timedelta
from io import BytesIO
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest

from app.models.enums import OvernightStatus
from app.models.person import Person
from app.models.person_work_day import PersonWorkDay
from app.models.work_time_entry import WorkTimeEntry
from app.services import payroll_month_xlsx_service as xlsx
from app.services.payroll_travel_expense_service import (
    PayrollTravelDay,
    PayrollTravelMarkings,
    aggregate_payroll_travel_days,
    build_payroll_travel_plan,
)
from app.services.payroll_xlsx_template import load_payroll_monthly_template


HOME = OvernightStatus.NONE
BEG = OvernightStatus.BEG_PAID
SELF = OvernightStatus.SELF_PAID
EMPTY = PayrollTravelMarkings()
HOME_MARK = PayrollTravelMarkings(travel_14=True)
ARRIVAL = PayrollTravelMarkings(travel_14=True, overnight_20=True)
BEG_MIDDLE = PayrollTravelMarkings(travel_10=True, travel_28=True)
SELF_MIDDLE = PayrollTravelMarkings(travel_10=True, travel_28=True, overnight_20=True)
NS = {"m": xlsx.SPREADSHEET_NS}


def calculate(statuses, *, start=date(2026, 8, 3), year=2026, month=8):
    return build_payroll_travel_plan(
        person_id=1, year=year, month=month,
        days={start + timedelta(days=i): PayrollTravelDay(status, True)
              for i, status in enumerate(statuses)},
    )


@pytest.mark.parametrize("statuses, expected", [
    ([HOME], [HOME_MARK]),
    ([HOME] * 3, [HOME_MARK] * 3),
    ([BEG, HOME], [ARRIVAL, HOME_MARK]),
    ([SELF, HOME], [ARRIVAL, HOME_MARK]),
    ([BEG, BEG, HOME], [ARRIVAL, BEG_MIDDLE, HOME_MARK]),
    ([SELF, SELF, HOME], [ARRIVAL, SELF_MIDDLE, HOME_MARK]),
    ([BEG] * 4 + [HOME], [ARRIVAL] + [BEG_MIDDLE] * 3 + [HOME_MARK]),
    ([SELF] * 4 + [HOME], [ARRIVAL] + [SELF_MIDDLE] * 3 + [HOME_MARK]),
    ([BEG] * 10 + [HOME], [ARRIVAL] + [BEG_MIDDLE] * 9 + [HOME_MARK]),
    ([BEG, SELF, BEG, SELF, HOME],
     [ARRIVAL, SELF_MIDDLE, BEG_MIDDLE, SELF_MIDDLE, HOME_MARK]),
    ([BEG, HOME, HOME, SELF, SELF, HOME],
     [ARRIVAL, HOME_MARK, HOME_MARK, ARRIVAL, SELF_MIDDLE, HOME_MARK]),
])
def test_expense_rules_for_home_short_long_and_separate_hotel_blocks(statuses, expected):
    plan = calculate(statuses)
    assert [plan.markings[date(2026, 8, 3) + timedelta(days=i)]
            for i in range(len(statuses))] == expected
    assert not plan.warnings


def test_hotel_block_continues_from_previous_month_even_when_payer_changes():
    plan = calculate([BEG, SELF, HOME], start=date(2026, 5, 31), year=2026, month=6)
    assert date(2026, 5, 31) not in plan.markings
    assert plan.markings[date(2026, 6, 1)] == SELF_MIDDLE
    assert plan.markings[date(2026, 6, 2)] == HOME_MARK


def test_continuing_hotel_and_departure_belong_to_their_respective_months():
    statuses = [BEG, BEG, SELF, HOME]
    august = calculate(statuses, start=date(2026, 8, 30))
    september = calculate(statuses, start=date(2026, 8, 30), month=9)
    assert august.markings[date(2026, 8, 30)] == ARRIVAL
    assert august.markings[date(2026, 8, 31)] == BEG_MIDDLE
    assert date(2026, 9, 1) not in august.markings
    assert september.markings[date(2026, 9, 1)] == SELF_MIDDLE
    assert september.markings[date(2026, 9, 2)] == HOME_MARK
    first_day_departure = calculate([SELF, HOME], start=date(2026, 8, 31), month=9)
    assert first_day_departure.markings[date(2026, 9, 1)] == HOME_MARK

    first_day_without_record = build_payroll_travel_plan(
        person_id=1, year=2026, month=9,
        days={date(2026, 8, 31): PayrollTravelDay(BEG, True)},
    )
    assert first_day_without_record.markings[date(2026, 9, 1)] == HOME_MARK
    assert not first_day_without_record.warnings


def test_hotel_continuation_also_works_across_year_boundary():
    plan = calculate([SELF, BEG, HOME], start=date(2026, 12, 31), year=2027, month=1)
    assert plan.markings[date(2027, 1, 1)] == BEG_MIDDLE
    assert plan.markings[date(2027, 1, 2)] == HOME_MARK


def test_missing_status_is_not_home_and_cannot_establish_a_new_hotel_arrival():
    plan = calculate([None, BEG, BEG, HOME])
    assert plan.markings[date(2026, 8, 3)] == EMPTY
    assert plan.markings[date(2026, 8, 4)] == EMPTY
    assert plan.markings[date(2026, 8, 5)] == BEG_MIDDLE
    assert [(w.person_id, w.work_date.day, w.code) for w in plan.warnings] == [
        (1, 3, "missing_overnight_status"), (1, 4, "unclear_hotel_block_start"),
    ]


def test_missing_status_after_last_hotel_night_is_the_departure_day():
    plan = build_payroll_travel_plan(person_id=1, year=2026, month=8, days={
        date(2026, 8, 27): PayrollTravelDay(BEG, True),
        date(2026, 8, 28): PayrollTravelDay(None, True),
    })
    assert plan.markings[date(2026, 8, 27)] == ARRIVAL
    assert plan.markings[date(2026, 8, 28)] == HOME_MARK
    assert not plan.warnings


def test_aggregation_deduplicates_dates_and_surfaces_conflicting_types():
    days = aggregate_payroll_travel_days(
        person_id=1, activity_dates={date(2026, 8, 3), date(2026, 8, 4)},
        work_days=[
            work_day(3, BEG), work_day(3, BEG), work_day(3, SELF), work_day(4, BEG),
            work_day(5, SELF, person_id=2),
        ],
    )
    assert len(days) == 2
    assert days[date(2026, 8, 3)].has_conflict
    plan = build_payroll_travel_plan(person_id=1, year=2026, month=8, days=days)
    assert plan.markings[date(2026, 8, 3)] == EMPTY
    assert plan.markings[date(2026, 8, 4)] == EMPTY
    assert plan.markings[date(2026, 8, 5)] == HOME_MARK
    assert [w.code for w in plan.warnings] == [
        "conflicting_overnight_status", "unclear_hotel_block_start",
    ]


def test_departure_follows_hotel_but_other_empty_dates_do_not_invent_trips():
    plan = build_payroll_travel_plan(person_id=1, year=2026, month=8, days={
        date(2026, 8, 3): PayrollTravelDay(BEG, False),
        date(2026, 8, 5): PayrollTravelDay(HOME, False),
        date(2026, 8, 6): PayrollTravelDay(SELF, False),
        date(2026, 8, 7): PayrollTravelDay(HOME, False),
    })
    assert plan.markings[date(2026, 8, 3)] == ARRIVAL
    assert plan.markings[date(2026, 8, 4)] == HOME_MARK
    assert plan.markings[date(2026, 8, 5)] == EMPTY
    assert plan.markings[date(2026, 8, 6)] == ARRIVAL
    assert plan.markings[date(2026, 8, 7)] == HOME_MARK


@pytest.mark.parametrize("year, month, length", [(2026, 2, 28), (2028, 2, 29),
                                               (2026, 4, 30), (2026, 8, 31)])
def test_only_valid_dates_are_returned(year, month, length):
    plan = build_payroll_travel_plan(person_id=1, year=year, month=month, days={})
    assert list(plan.markings) == [date(year, month, i) for i in range(1, length + 1)]
    assert set(plan.markings.values()) == {EMPTY}


def test_excel_columns_and_dates_match_the_template_and_are_idempotent():
    sheet = template_sheet()
    before = deepcopy(sheet)
    plan = calculate([BEG, BEG, HOME, SELF, SELF, HOME])
    xlsx.write_payroll_travel_expenses(sheet, year=2026, month=8, plan=plan)
    expected = {12: ("", "x", "", "x"), 13: ("x", "", "x", ""),
                14: ("", "x", "", ""), 15: ("", "x", "", "x"),
                16: ("x", "", "x", "x"), 17: ("", "x", "", "")}
    for row in range(10, 41):
        assert tuple(cell_text(sheet, f"{col}{row}") for col in "IJKL") == expected.get(
            row, ("", "", "", ""),
        )
    assert without_markings(sheet, 31) == without_markings(before, 31)
    once = ET.tostring(sheet)
    xlsx.write_payroll_travel_expenses(sheet, year=2026, month=8, plan=plan)
    assert ET.tostring(sheet) == once
    xlsx.write_payroll_travel_expenses(
        sheet, year=2026, month=8,
        plan=build_payroll_travel_plan(person_id=1, year=2026, month=8, days={}),
    )
    assert all(cell_text(sheet, f"{col}{row}") == ""
               for row in range(10, 41) for col in "IJKL")


@pytest.mark.parametrize("year, month, length", [(2026, 2, 28), (2028, 2, 29),
                                               (2026, 4, 30), (2026, 8, 31)])
def test_excel_writer_only_clears_valid_daily_expense_cells(year, month, length):
    sheet = template_sheet()
    for row in range(10, 41):
        for col in "IJKL":
            xlsx._set_cell_string(sheet, f"{col}{row}", "x")
    before = deepcopy(sheet)
    xlsx.write_payroll_travel_expenses(
        sheet, year=year, month=month,
        plan=build_payroll_travel_plan(person_id=1, year=year, month=month, days={}),
    )
    assert without_markings(sheet, length) == without_markings(before, length)
    for row in range(10, 41):
        for col in "IJKL":
            assert cell_text(sheet, f"{col}{row}") == ("" if row < 10 + length else "x")


def test_expense_writer_does_not_overwrite_formulas_in_a_changed_template():
    sheet = template_sheet()
    xlsx._set_cell_formula(sheet, "J10", "1+1", 2)
    with pytest.raises(ValueError, match="J10.*Formel"):
        xlsx.write_payroll_travel_expenses(sheet, year=2026, month=8, plan=calculate([HOME]))
    assert sheet.find('.//m:c[@r="J10"]/m:f', NS).text == "1+1"


def test_multiple_time_entries_use_one_daily_selection_and_ignore_other_workers():
    entries = [entry(3, BEG, entry_id=1), entry(3, BEG, entry_id=2),
               entry(4, BEG), entry(5, HOME), entry(3, SELF, person_id=2)]
    result = xlsx.build_payroll_month_xlsx(person=worker(), year=2026, month=8, entries=entries)
    with ZipFile(BytesIO(result.content)) as archive:
        assert archive.testzip() is None
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        assert cell_text(sheet, "J12") == "x"
        assert cell_text(sheet, "L12") == "x"
        assert cell_text(sheet, "I13") == "x"
        assert cell_text(sheet, "L13") == ""
        assert cell_text(sheet, "J14") == "x"
    assert result.plan.travel_expenses.warnings == ()


def test_export_marks_friday_after_last_hotel_night_without_own_status():
    result = xlsx.build_payroll_month_xlsx(
        person=worker(), year=2026, month=8,
        entries=[entry(27, BEG), entry(28, None)],
    )
    with ZipFile(BytesIO(result.content)) as archive:
        assert archive.testzip() is None
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        assert tuple(cell_text(sheet, f"{col}36") for col in "IJKL") == (
            "", "x", "", "x",
        )
        assert tuple(cell_text(sheet, f"{col}37") for col in "IJKL") == (
            "", "x", "", "",
        )
    assert result.plan.travel_expenses.warnings == ()


def test_travel_only_booking_is_relevant_but_gps_suggestion_is_not():
    travel = entry(3, HOME)
    travel.work_minutes = 0
    travel.travel_minutes = 60
    gps = entry(4, HOME)
    gps.source = "gps_suggestion"
    plan = xlsx.build_payroll_month_plan(
        person=worker(), year=2026, month=8, entries=[travel, gps],
    )
    assert plan.travel_expenses.markings[date(2026, 8, 3)] == HOME_MARK
    assert plan.travel_expenses.markings[date(2026, 8, 4)] == EMPTY


def test_five_day_distribution_does_not_invent_an_overnight_choice():
    entries = [entry(day, HOME) for day in range(3, 7)]
    for item in entries:
        item.work_minutes = 9 * 60
    plan = xlsx.build_payroll_month_plan(person=worker(), year=2026, month=8, entries=entries)
    assert sum(day.net_work_minutes for day in plan.days) == 36 * 60
    assert next(day for day in plan.days if day.work_date.day == 7).is_derived
    assert plan.travel_expenses.markings[date(2026, 8, 7)] == EMPTY
    assert all(plan.travel_expenses.markings[date(2026, 8, day)] == HOME_MARK
               for day in range(3, 7))


def test_export_exposes_and_logs_conflicts_without_selecting_a_travel_type(caplog):
    result = xlsx.build_payroll_month_xlsx(
        person=worker(), year=2026, month=8,
        entries=[entry(3, BEG, entry_id=1), entry(3, SELF, entry_id=2), entry(4, SELF)],
    )
    assert result.plan.travel_expenses.markings[date(2026, 8, 3)] == EMPTY
    assert result.plan.travel_expenses.markings[date(2026, 8, 4)] == EMPTY
    assert "person_id=1, Datum=2026-08-03, Grund=conflicting_overnight_status" in caplog.text
    assert "person_id=1, Datum=2026-08-04, Grund=unclear_hotel_block_start" in caplog.text


def test_workbook_diff_is_limited_to_expense_values_and_preserves_all_xml_parts(monkeypatch):
    args = dict(person=worker(), year=2026, month=8, entries=[entry(3, BEG), entry(4, SELF)])
    modified = xlsx.build_payroll_month_xlsx(**args).content
    monkeypatch.setattr(xlsx, "write_payroll_travel_expenses", lambda *a, **kw: None)
    baseline = xlsx.build_payroll_month_xlsx(**args).content
    with ZipFile(BytesIO(modified)) as after, ZipFile(BytesIO(baseline)) as before:
        assert after.namelist() == before.namelist()
        for name in after.namelist():
            if name.endswith((".xml", ".rels")):
                ET.fromstring(after.read(name))
            if name == "xl/worksheets/sheet1.xml":
                assert without_markings(ET.fromstring(after.read(name)), 31) == without_markings(
                    ET.fromstring(before.read(name)), 31,
                )
            else:
                assert after.read(name) == before.read(name), name


def test_parallel_repeated_single_and_multi_sheet_exports_are_independent():
    template_before = load_payroll_monthly_template().getvalue()
    args = dict(person=worker(), year=2026, month=8, entries=[entry(3, BEG), entry(4, BEG)])
    second_args = dict(person=worker(2), year=2026, month=8,
                       entries=[entry(3, SELF, person_id=2), entry(4, SELF, person_id=2)])
    with ThreadPoolExecutor(max_workers=3) as pool:
        first, second, repeated = list(pool.map(
            lambda values: xlsx.build_payroll_month_xlsx(**values), [args, second_args, args],
        ))
    multi = xlsx.build_payroll_months_xlsx([
        xlsx.PayrollMonthSheet(sheet_name="Erika Test", **args),
        xlsx.PayrollMonthSheet(sheet_name="Zweite Person", **second_args),
    ])
    with ZipFile(BytesIO(multi.content)) as all_sheets:
        for index, single in enumerate((first, second), start=1):
            with ZipFile(BytesIO(single.content)) as workbook:
                assert workbook.read("xl/worksheets/sheet1.xml") == all_sheets.read(
                    f"xl/worksheets/sheet{index}.xml",
                )
    assert first.content == repeated.content
    assert load_payroll_monthly_template().getvalue() == template_before


def worker(person_id=1):
    return Person(id=person_id, first_name="Erika", last_name="Test", display_name="Erika Test",
                  weekly_hours=40, short_code="ET")


def work_day(day, status, *, person_id=1):
    return PersonWorkDay(person_id=person_id, work_date=date(2026, 8, day),
                         overnight_status=status)


def entry(day, status, *, entry_id=None, person_id=1):
    item = WorkTimeEntry(id=entry_id or day, person_id=person_id,
                         work_date=date(2026, 8, day), start_time=time(6), end_time=time(14),
                         break_minutes=0, travel_minutes=0, work_minutes=480, source="manual")
    if status is not None:
        item.work_day = work_day(day, status, person_id=person_id)
    return item


def template_sheet():
    with ZipFile(load_payroll_monthly_template()) as archive:
        return ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))


def cell_text(sheet, ref):
    cell = sheet.find(f'.//m:c[@r="{ref}"]', NS)
    return "".join(cell.itertext())


def without_markings(sheet, valid_days):
    clone = deepcopy(sheet)
    for row in range(10, 10 + valid_days):
        for col in "IJKL":
            xlsx._clear_cell(clone, f"{col}{row}")
    return ET.tostring(clone)
