from hashlib import sha256
from io import BytesIO
from zipfile import ZipFile

import pytest

from app.services import payroll_xlsx_template
from app.services.payroll_xlsx_template import (
    PayrollXlsxTemplateError,
    load_payroll_monthly_template,
)


def test_payroll_monthly_template_loads_as_independent_buffers(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = load_payroll_monthly_template()
    second = load_payroll_monthly_template()

    first_content = first.getvalue()
    second_content = second.getvalue()
    assert first is not second
    assert first_content == second_content
    assert sha256(first_content).hexdigest() == sha256(second_content).hexdigest()

    first.seek(0)
    first.write(b"changed working copy")
    third_content = load_payroll_monthly_template().getvalue()
    assert third_content == second_content

    with ZipFile(BytesIO(third_content)) as workbook:
        assert workbook.testzip() is None
        assert "xl/workbook.xml" in workbook.namelist()
        assert "xl/worksheets/sheet1.xml" in workbook.namelist()
        assert "xl/media/image1.png" in workbook.namelist()


def test_payroll_monthly_template_reports_missing_resource(monkeypatch):
    monkeypatch.setattr(
        payroll_xlsx_template,
        "PAYROLL_MONTHLY_TEMPLATE_RESOURCE",
        "templates/time_entries/Fehlende_Monatsvorlage.xlsx",
    )

    with pytest.raises(PayrollXlsxTemplateError, match="fehlt"):
        load_payroll_monthly_template()


def test_payroll_monthly_template_reports_damaged_workbook(monkeypatch):
    class DamagedResource:
        def joinpath(self, _resource: str) -> "DamagedResource":
            return self

        def read_bytes(self) -> bytes:
            return b"keine Excel-Datei"

    monkeypatch.setattr(
        payroll_xlsx_template.resources,
        "files",
        lambda _package: DamagedResource(),
    )

    with pytest.raises(PayrollXlsxTemplateError, match="beschädigt"):
        load_payroll_monthly_template()
