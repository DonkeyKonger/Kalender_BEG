from datetime import date
from io import BytesIO
from zipfile import ZipFile

from app.services.time_entry_xlsx_export_service import build_weekly_worker_xlsx, weekly_worker_rows


def test_weekly_worker_xlsx_uses_polished_table_layout():
    content = build_weekly_worker_xlsx(
        person_name="Marcin Cholewa",
        week_number=24,
        year=2026,
        start=date(2026, 6, 8),
        end=date(2026, 6, 14),
        rows=weekly_worker_rows(date(2026, 6, 8), date(2026, 6, 14), [], {}),
    )

    with ZipFile(BytesIO(content)) as workbook:
        names = set(workbook.namelist())
        worksheet = workbook.read("xl/worksheets/sheet1.xml").decode()
        table = workbook.read("xl/tables/table1.xml").decode()

    assert "xl/tables/table1.xml" in names
    assert "xl/drawings/drawing1.xml" in names
    assert "xl/media/beg_logo_icon.png" in names
    assert "LohnpruefungMonteurwoche" in table
    assert 'ref="A8:L15"' in table
    assert 'topLeftCell="A9"' in worksheet
    assert 'orientation="landscape"' in worksheet
    assert 'fitToWidth="1"' in worksheet
    assert 'ht="32" customHeight="1"' in worksheet
