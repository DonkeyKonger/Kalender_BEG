from decimal import Decimal
from io import BytesIO
from math import ceil

import pytest
from fastapi import HTTPException
from pypdf import PdfReader

from app.models.site_measurement_item import SiteMeasurementItem
from app.services.measurement_pdf_service import MeasurementPdfService
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import create_measurement_base, create_site, db_session


def add_position(db, base, position, description, *, hidden=False):
    item = SiteMeasurementItem(
        site_id=base.site_id, measurement_base_id=base.id,
        position=position, description=description, sort_order=int(position.split(".")[-1]),
        list_quantity=Decimal("12.00"), unit="m", minutes_per_unit=Decimal("2.50"),
        list_minutes_total=Decimal("30.00"), is_hidden=hidden,
    )
    db.add(item)
    db.flush()
    return item


@pytest.mark.parametrize("visible_count", [0, 1, 18, 19])
def test_mobile_timesheet_pdf_reflects_hidden_positions_and_repaginates(visible_count, tmp_path):
    with db_session() as db:
        site = create_site(db)
        base = create_measurement_base(db, site)
        base.name = "Hauptauftrag Testbaustelle"
        hidden = [add_position(db, base, f"X.{i}", f"Entfernte Leistung {i}") for i in range(1, 20)]
        for i in range(1, visible_count + 1):
            add_position(db, base, f"N3.1.{i}", f"Kabelrinne {i} liefern und montieren")
        db.commit()
        service = MeasurementPdfService(db)
        before, _ = service.build_active_timesheet_pdf(site_id=site.id)
        assert "Entfernte Leistung" in "".join(page.extract_text() for page in PdfReader(BytesIO(before)).pages)

        # Use the exact service action invoked by the grey x in execution progress.
        for item in hidden:
            MeasurementService(db).hide_item(site_id=site.id, measurement_item_id=item.id)
        content, filename = service.build_active_timesheet_pdf(site_id=site.id)
        reader = PdfReader(BytesIO(content))
        text = "\n".join(page.extract_text() for page in reader.pages)
        assert "Entfernte Leistung" not in text
        assert len(reader.pages) == max(1, ceil(visible_count / 18))
        assert filename == "Zeitenliste_Hauptauftrag_Testbaustelle.pdf"
        for i in range(1, visible_count + 1):
            assert f"N3.1.{i} Kabelrinne {i} " in text
        if visible_count == 0:
            assert "Keine Positionen in der aktiven Zeitenliste." in text
        else:
            assert "Keine Positionen" not in text
        assert all(db.get(SiteMeasurementItem, item.id).is_hidden for item in hidden)
        if visible_count == 19:
            sample = tmp_path / "monteur-zeitenliste.pdf"
            sample.write_bytes(content)
            print(f"PDF-QA: {sample}")


def test_mobile_timesheet_pdf_excludes_retained_history_and_other_bases():
    with db_session() as db:
        site = create_site(db)
        active = create_measurement_base(db, site)
        old_base = create_measurement_base(db, site)
        old_base.status = "draft"
        old_base.released_to_mobile = False
        other_site = create_site(db)
        other_base = create_measurement_base(db, other_site)
        add_position(db, active, "N3.1.10", "Alter falscher Inhalt", hidden=True)
        add_position(db, active, "N3.1.10", "Neuer korrekter Inhalt")
        add_position(db, old_base, "N3.1.11", "Anderes Aufmassblatt")
        add_position(db, other_base, "N3.1.12", "Andere Baustelle")
        db.commit()

        content, _ = MeasurementPdfService(db).build_active_timesheet_pdf(site_id=site.id)
        text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(content)).pages)
        assert text.count("N3.1.10") == 1
        assert "Neuer korrekter Inhalt" in text
        for excluded in ("Alter falscher Inhalt", "Anderes Aufmassblatt", "Andere Baustelle"):
            assert excluded not in text


def test_mobile_timesheet_pdf_still_requires_mobile_release():
    with db_session() as db:
        site = create_site(db)
        base = create_measurement_base(db, site)
        base.released_to_mobile = False
        db.commit()
        with pytest.raises(HTTPException) as error:
            MeasurementPdfService(db).build_active_timesheet_pdf(site_id=site.id)
        assert error.value.status_code == 404
