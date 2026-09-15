from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.site_measurement_item import (
    SiteMeasurementBatch, SiteMeasurementEntry, SiteMeasurementItem,
)
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import (
    create_measurement_base, create_site, db_session, parsed_timesheet_positions,
)


@pytest.mark.parametrize("reference", [
    None, "quantity", "linked", "outgoing_link", "submitted", "signed", "history", "override", "batch",
])
def test_hidden_position_is_replaced_with_fresh_content_and_history_is_preserved(monkeypatch, reference):
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    service = MeasurementService(db)
    parsed = {
        b"old": parsed_timesheet_positions(
            invoice_number="same-invoice", positions=["N3.1.10", "N3.2.10", "N3.9.10"],
            description_prefix="Falsch",
        ),
        b"new": parsed_timesheet_positions(
            invoice_number="same-invoice", positions=["N3.1.10", "N3.2.10", "N3.3.10"],
            description_prefix="Korrektur",
        ),
    }
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda content: parsed[content],
    )
    _, originals = service.import_timesheet(
        site.id, file_name="old.pdf", pdf_content=b"old", measurement_base_id=base.id,
    )
    old, visible, unrelated = originals
    old_id = old.id
    old.list_quantity = Decimal("999.00")
    old.unit = "m"
    old.minutes_per_unit = Decimal("999.00")
    old.is_hidden = True
    unrelated.is_hidden = True

    batch = SiteMeasurementBatch(
        site_id=site.id, measurement_base_id=base.id, number=1, title="Historie",
        status="billed", deleted_at=datetime.now(timezone.utc),
    )
    db.add(batch)
    db.flush()
    entry = linked = None
    if reference == "quantity":
        entry = SiteMeasurementEntry(
            measurement_batch_id=batch.id, measurement_item_id=old.id, site_id=site.id,
            quantity=Decimal("3.00"), submitted_quantity=Decimal("2.00"),
            area_or_comment="EG", status="submitted",
        )
        db.add(entry)
    elif reference == "linked":
        linked = SiteMeasurementItem(
            site_id=site.id, measurement_base_id=base.id, measurement_batch_id=batch.id,
            position="FREI-1", description="Historische Verknüpfung", sort_order=10,
            linked_measurement_item_id=old.id, is_hidden=True, is_free_position=True,
        )
        db.add(linked)
    elif reference == "outgoing_link":
        old.linked_measurement_item_id = visible.id
    elif reference in {"submitted", "signed"}:
        field = "original_submitted_snapshot" if reference == "submitted" else "customer_signed_snapshot"
        setattr(batch, field, {"entries": [{"measurement_item_id": old.id, "description": old.description}]})
    elif reference == "history":
        batch.status_history = [{"previous": {"customer_signed_snapshot": {
            "items": [{"measurement_item_id": str(old.id)}],
        }}}]
    elif reference == "override":
        batch.item_overrides = {str(old.id): {"description": "Historischer Text"}}
    elif reference == "batch":
        old.measurement_batch_id = batch.id
    db.commit()
    historical_values = deepcopy([
        batch.original_submitted_snapshot, batch.customer_signed_snapshot,
        batch.status_history, batch.item_overrides,
    ])

    summary, imported = service.import_timesheet(
        site.id, file_name="new.pdf", pdf_content=b"new", measurement_base_id=base.id,
    )
    assert summary["imported_count"] == 2
    assert [item.position for item in imported] == ["N3.1.10", "N3.3.10"]
    replacement = imported[0]
    assert replacement.id != old_id
    assert replacement.description == "Korrektur N3.1.10"
    assert replacement.source_file_name == "new.pdf"
    assert replacement.list_quantity == Decimal("10.00")
    assert replacement.minutes_per_unit == Decimal("10.00")
    assert replacement.unit == "Stck"
    assert replacement.is_hidden is False
    assert replacement.entries == []
    assert visible.description == "Falsch N3.2.10"
    assert db.get(SiteMeasurementItem, unrelated.id).is_hidden is True
    db.expire_all()
    retained = db.get(SiteMeasurementItem, old_id)
    if reference is None:
        assert retained is None
    else:
        assert retained.is_hidden is True
        assert retained.description == "Falsch N3.1.10"
        assert retained.list_quantity == Decimal("999.00")
    if entry is not None:
        assert entry.measurement_item_id == old_id
        assert entry.quantity == Decimal("3.00")
        assert entry.submitted_quantity == Decimal("2.00")
    if linked is not None:
        assert linked.linked_measurement_item_id == old_id
    assert [batch.original_submitted_snapshot, batch.customer_signed_snapshot,
            batch.status_history, batch.item_overrides] == historical_values
    assert [item.position for item in service.list_items(site.id, measurement_base_id=base.id)].count("N3.1.10") == 1

    # The fresh visible row must block another copy, without deleting history.
    with pytest.raises(HTTPException, match="Keine neuen Positionen"):
        service.import_timesheet(
            site.id, file_name="new.pdf", pdf_content=b"new", measurement_base_id=base.id,
        )


def test_hidden_replacement_is_scoped_to_selected_base_and_site(monkeypatch):
    db = db_session()
    site = create_site(db)
    other_site = create_site(db)
    bases = [create_measurement_base(db, site), create_measurement_base(db, site),
             create_measurement_base(db, other_site)]
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda _: parsed_timesheet_positions(
            invoice_number="1", positions=["N3.1.10"], description_prefix="Position",
        ),
    )
    service = MeasurementService(db)
    old_ids = []
    for base in bases:
        _, items = service.import_timesheet(
            base.site_id, file_name="old.pdf", pdf_content=b"pdf", measurement_base_id=base.id,
        )
        old_ids.append(items[0].id)
        service.hide_item(site_id=base.site_id, measurement_item_id=items[0].id)
    summary, _ = service.import_timesheet(
        site.id, file_name="new.pdf", pdf_content=b"pdf", measurement_base_id=bases[0].id,
    )
    assert summary["imported_count"] == 1
    db.expire_all()
    assert db.get(SiteMeasurementItem, old_ids[0]) is None
    for item_id in old_ids[1:]:
        assert db.get(SiteMeasurementItem, item_id).is_hidden is True
