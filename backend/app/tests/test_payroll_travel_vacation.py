from datetime import date, timedelta
from io import BytesIO
from zipfile import ZipFile
import hashlib
import xml.etree.ElementTree as ET

import pytest

from app.models.enums import AbsenceStatus, AbsenceType
from app.services import payroll_month_xlsx_service as xlsx
from app.services.payroll_travel_expense_service import (
    PayrollTravelDay, build_payroll_travel_plan,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_individual_month_download import approved_workers as approved_workers
from app.tests.test_payroll_month_absences import absence
from app.tests.test_payroll_travel_expenses import (
    BEG, SELF, HOME, EMPTY, HOME_MARK, SELF_ARRIVAL, SELF_MIDDLE,
    NS, cell_text, entry, worker, work_day,
)


def read_sheet(content, index=1):
    with ZipFile(BytesIO(content)) as book:
        return ET.fromstring(book.read(f"xl/worksheets/sheet{index}.xml"))


def markings(sheet, day):
    return tuple(cell_text(sheet, f"{column}{day + 9}") for column in "IJKL")


@pytest.mark.parametrize("worked_days", [1, 2, 3, 4])
@pytest.mark.parametrize("payer", [BEG, SELF])
def test_vacation_shortens_trip_and_updates_nights_and_totals(worked_days, payer):
    entries = [entry(day, payer) for day in range(3, 3 + worked_days)]
    records = [absence(AbsenceType.VACATION, date(2026, 8, 3 + worked_days), date(2026, 8, 7))]
    args = dict(person=worker(), year=2026, month=8, entries=entries, absences=records)
    result = xlsx.build_payroll_month_xlsx(**args)
    combined = xlsx.build_payroll_months_xlsx([xlsx.PayrollMonthSheet(sheet_name="Test", **args)])
    assert all(item.work_day.overnight_status == payer for item in entries)
    assert result.plan == combined.plans[0]
    assert not result.plan.travel_expenses.warnings
    for content in (result.content, combined.content, prepare_payroll_workbook_download(result.content)):
        sheet = read_sheet(content)
        for offset in range(5):
            day = 3 + offset
            if offset >= worked_days:
                expected = ("", "", "", "")
            elif offset == worked_days - 1:
                expected = ("", "x", "", "")
                assert cell_text(sheet, f"F{day + 9}") == "–"
            else:
                expected = ("" if offset == 0 else "x", "x" if offset == 0 else "",
                            "" if offset == 0 else "x", "x" if payer == SELF else "")
            assert markings(sheet, day) == expected
        counts = (max(worked_days - 2, 0), min(worked_days, 2), max(worked_days - 2, 0),
                  worked_days - 1 if payer == SELF else 0)
        for row, count, rate in zip(range(49, 53), counts, (10, 14, 28, 20), strict=True):
            assert float(sheet.find(f'.//m:c[@r="E{row}"]/m:v', NS).text) == count
            assert float(sheet.find(f'.//m:c[@r="G{row}"]/m:v', NS).text) == count * rate


def test_vacation_clears_stale_hotel_selections_and_restarts_the_trip_afterwards():
    days = {date(2026, 8, i): PayrollTravelDay(SELF, i not in (5, 6)) for i in range(3, 9)}
    plan = build_payroll_travel_plan(
        person_id=1, year=2026, month=8, days=days,
        vacation_dates={date(2026, 8, 5), date(2026, 8, 6)},
    )
    assert [plan.markings[date(2026, 8, i)] for i in range(3, 9)] == [
        SELF_ARRIVAL, HOME_MARK, EMPTY, EMPTY, SELF_ARRIVAL, SELF_MIDDLE,
    ]
    assert days[date(2026, 8, 4)].overnight_status == SELF
    assert not plan.warnings


@pytest.mark.parametrize("last_day", [date(2026, 9, 30), date(2026, 12, 31)])
def test_vacation_boundary_is_applied_on_both_sides_of_a_month_change(last_day):
    vacation_day = last_day + timedelta(days=1)
    days = {last_day: PayrollTravelDay(SELF, True)}
    for selected in (last_day, vacation_day):
        plan = build_payroll_travel_plan(
            person_id=1, year=selected.year, month=selected.month,
            days=days, vacation_dates={vacation_day},
        )
        assert plan.markings[selected] == (HOME_MARK if selected == last_day else EMPTY)
    item = entry(3, SELF)
    item.work_date = item.work_day.work_date = last_day
    result = xlsx.build_payroll_month_xlsx(
        person=worker(), year=last_day.year, month=last_day.month, entries=[item],
        absences=[absence(AbsenceType.VACATION, vacation_day)],
    )
    assert result.plan.days[0].overnight_status == HOME
    assert markings(read_sheet(result.content), last_day.day) == ("", "x", "", "")


@pytest.mark.parametrize("values", [
    {"status": AbsenceStatus.CANCELLED}, {"person_id": 2}, {"absence_type": AbsenceType.SCHOOL},
])
def test_unrelated_or_cancelled_absences_do_not_shorten_a_trip(values):
    record = absence(AbsenceType.VACATION, date(2026, 8, 5))
    for key, value in values.items():
        setattr(record, key, value)
    plan = xlsx.build_payroll_month_plan(
        person=worker(), year=2026, month=8, entries=[entry(3, SELF), entry(4, SELF)], absences=[record],
    )
    assert plan.travel_expenses.markings[date(2026, 8, 4)] == SELF_MIDDLE
    assert plan.travel_expenses.markings[date(2026, 8, 5)] == HOME_MARK


def test_actual_work_keeps_priority_over_overlapping_vacation():
    plan = xlsx.build_payroll_month_plan(
        person=worker(), year=2026, month=8,
        entries=[entry(3, SELF), entry(4, SELF), entry(5, HOME)],
        absences=[absence(AbsenceType.VACATION, date(2026, 8, 4))],
    )
    assert plan.travel_expenses.markings[date(2026, 8, 3)] == SELF_ARRIVAL
    assert plan.travel_expenses.markings[date(2026, 8, 4)] == SELF_MIDDLE


def test_full_vacation_week_never_gets_expenses_from_stale_work_day_selections():
    result = xlsx.build_payroll_month_xlsx(
        person=worker(), year=2026, month=8, entries=[],
        work_days=[work_day(day, SELF) for day in range(3, 8)],
        absences=[absence(AbsenceType.VACATION, date(2026, 8, 3), date(2026, 8, 7))],
    )
    assert all(mark == EMPTY for mark in result.plan.travel_expenses.markings.values())
    assert not result.plan.travel_expenses.warnings


@pytest.fixture
def retained_vacation_workbook(monkeypatch):
    def legacy_travel_plan(**kwargs):
        kwargs.pop("vacation_dates", None)
        return build_payroll_travel_plan(**kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(xlsx, "build_payroll_travel_plan", legacy_travel_plan)
        return xlsx.build_payroll_months_xlsx([
            xlsx.PayrollMonthSheet(
                person=worker(), sheet_name="Test", year=2026, month=8,
                entries=[entry(day, SELF) for day in (3, 4, 5)],
                absences=[absence(AbsenceType.VACATION, date(2026, 8, 6), date(2026, 8, 7))],
            ),
        ]).content


def test_retained_vacation_ends_and_restarts_travel_despite_stale_hotel_selections(monkeypatch):
    def legacy_travel_plan(**kwargs):
        kwargs.pop("vacation_dates", None)
        return build_payroll_travel_plan(**kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(xlsx, "build_payroll_travel_plan", legacy_travel_plan)
        old = xlsx.build_payroll_month_xlsx(
            person=worker(), year=2026, month=8,
            entries=[entry(3, SELF), entry(4, SELF), entry(7, SELF), entry(8, HOME)],
            work_days=[work_day(5, SELF), work_day(6, SELF)],
            absences=[absence(AbsenceType.VACATION, date(2026, 8, 5), date(2026, 8, 6))],
        ).content
    corrected = prepare_payroll_workbook_download(old)
    sheet = read_sheet(corrected)
    assert markings(sheet, 4) == ("", "x", "", "")
    assert markings(sheet, 5) == markings(sheet, 6) == ("", "", "", "")
    assert markings(sheet, 7) == ("", "x", "", "x")
    assert markings(sheet, 8) == ("", "x", "", "")
    assert prepare_payroll_workbook_download(corrected) == corrected


def assert_corrected_retained_trip(content, index=1):
    sheet = read_sheet(content, index)
    assert [markings(sheet, day) for day in range(3, 8)] == [
        ("", "x", "", "x"), ("x", "", "x", "x"), ("", "x", "", ""),
        ("", "", "", ""), ("", "", "", ""),
    ]
    assert cell_text(sheet, "F14") == "–"
    assert [float(sheet.find(f'.//m:c[@r="E{row}"]/m:v', NS).text) for row in range(49, 53)] == [1, 2, 1, 2]
    assert [float(sheet.find(f'.//m:c[@r="G{row}"]/m:v', NS).text) for row in range(49, 53)] == [10, 28, 28, 40]


def test_retained_download_corrects_vacation_and_is_idempotent(retained_vacation_workbook):
    old = retained_vacation_workbook
    assert markings(read_sheet(old), 6) == ("", "x", "", "")
    corrected = prepare_payroll_workbook_download(old)
    assert_corrected_retained_trip(corrected)
    assert prepare_payroll_workbook_download(corrected) == corrected


@pytest.mark.parametrize("ref", ["J14", "E49"])
def test_retained_custom_travel_formulas_are_preserved(retained_vacation_workbook, ref):
    output = BytesIO()
    with ZipFile(BytesIO(retained_vacation_workbook)) as source, ZipFile(output, "w") as target:
        for item in source.infolist():
            payload = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                sheet = ET.fromstring(payload)
                xlsx._set_cell_formula(sheet, ref, "1+1", 2)
                payload = xlsx._preserve_ignorable_namespaces(ET.tostring(sheet))
            target.writestr(item, payload)
    sheet = read_sheet(prepare_payroll_workbook_download(output.getvalue()))
    assert sheet.find(f'.//m:c[@r="{ref}"]/m:f', NS).text == "1+1"
    assert cell_text(sheet, "F14") == "MA"
    assert markings(sheet, 6) == ("", "x", "", "")


def test_single_and_combined_approved_downloads_keep_stored_artifact_unchanged(
    approved_workers, retained_vacation_workbook,
):
    case = approved_workers
    artifact = case.artifacts[0]
    artifact.content = retained_vacation_workbook
    artifact.byte_size = len(artifact.content)
    artifact.content_sha256 = hashlib.sha256(artifact.content).hexdigest()
    case.db.commit()
    assert_corrected_retained_trip(case.service.worker_export(person_id=artifact.person_id, **case.args))
    combined = case.service.all_workers_export(**case.args)
    # The fixture's first employee remains the first worksheet in the merge.
    assert_corrected_retained_trip(combined)
    assert artifact.content == retained_vacation_workbook
    assert artifact.content_sha256 == hashlib.sha256(retained_vacation_workbook).hexdigest()
    assert not case.db.new and not case.db.dirty and not case.db.deleted
