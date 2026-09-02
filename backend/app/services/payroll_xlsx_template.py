from __future__ import annotations

import xml.etree.ElementTree as ET
from importlib import resources
from io import BytesIO
from zipfile import BadZipFile, ZipFile


PAYROLL_MONTHLY_TEMPLATE_RESOURCE = "templates/time_entries/Lohn_Monatszettel_Master.xlsx"
REQUIRED_XLSX_PARTS = {
    "[Content_Types].xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
}


class PayrollXlsxTemplateError(RuntimeError):
    """Die hinterlegte Mastervorlage kann nicht sicher verwendet werden."""


def load_payroll_monthly_template() -> BytesIO:
    """Lädt die unveränderte Mastervorlage in einen neuen, unabhängigen Puffer."""
    try:
        content = resources.files("app").joinpath(PAYROLL_MONTHLY_TEMPLATE_RESOURCE).read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError) as exc:
        raise PayrollXlsxTemplateError(
            "Die Excel-Mastervorlage für die Monatsabrechnung fehlt."
        ) from exc

    _validate_payroll_monthly_template(content)
    return BytesIO(content)


def _validate_payroll_monthly_template(content: bytes) -> None:
    try:
        with ZipFile(BytesIO(content)) as workbook:
            missing_parts = REQUIRED_XLSX_PARTS.difference(workbook.namelist())
            if missing_parts or workbook.testzip() is not None:
                raise PayrollXlsxTemplateError(
                    "Die Excel-Mastervorlage für die Monatsabrechnung ist beschädigt."
                )
            ET.fromstring(workbook.read("xl/workbook.xml"))
    except PayrollXlsxTemplateError:
        raise
    except (BadZipFile, KeyError, ET.ParseError, OSError) as exc:
        raise PayrollXlsxTemplateError(
            "Die Excel-Mastervorlage für die Monatsabrechnung ist beschädigt."
        ) from exc
