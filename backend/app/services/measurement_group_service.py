"""A frozen document projection, never a second set of billable quantities."""
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.models.measurement_group import MeasurementGroup, MeasurementGroupMember, invalidate_groups
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
from app.schemas.measurement import MeasurementGroupRead
from app.services.document_pdf_cache import build_pdf_version_hash
from app.services.measurement_status_history import COMPLETED_STATUSES


def _normalized(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=None).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value.normalize())
    return value


def source_version(batch):
    """Uses already eager-loaded overview data, not signature/snapshot blobs.

    The flush hook handles regular writes. This additional check catches bulk
    imports/SQL updates as well, including catalog changes without batch updates.
    """
    omitted = {"internal_label", "original_submitted_snapshot", "customer_signed_snapshot",
               "worker_signature_strokes", "customer_signature_strokes"}
    def columns(obj):
        return {attr.key: _normalized(getattr(obj, attr.key)) for attr in inspect(type(obj)).column_attrs
                if attr.key not in omitted}
    items = {item.id: item for item in batch.free_items}
    items.update({entry.measurement_item.id: entry.measurement_item for entry in batch.entries if entry.measurement_item})
    return build_pdf_version_hash({
        "batch": columns(batch),
        "entries": [columns(row) for row in sorted(batch.entries, key=lambda row: row.id)],
        "areas": [columns(row) for row in sorted(batch.area_rows, key=lambda row: row.id)],
        "items": [columns(items[key]) for key in sorted(items)],
    })


def group_is_current(group, batches):
    return group.invalidated_at is None and all(
        source["id"] in batches
        and batches[source["id"]].deleted_at is None
        and batches[source["id"]].status in COMPLETED_STATUSES
        and source["version"] == source_version(batches[source["id"]])
        for source in group.sources
    )


def group_read(group):
    return MeasurementGroupRead.model_validate(group, from_attributes=True)


def groups_for_overview(db, site_id, batches):
    by_id = {batch.id: batch for batch in batches}
    result = {}
    for group in db.scalars(select(MeasurementGroup).where(
        MeasurementGroup.site_id == site_id, MeasurementGroup.invalidated_at.is_(None)).execution_options(populate_existing=True)):
        if group_is_current(group, by_id):
            summary = group_read(group)
            for source in group.sources:
                result[source["id"]] = summary
    return result


def _has_ink(strokes):
    def valid(point):
        return isinstance(point, dict) and all(isinstance(point.get(axis), (int, float))
                                              and 0 <= point[axis] <= 1 for axis in ("x", "y"))
    return bool(strokes and any(sum(valid(point) for point in stroke) >= 2 for stroke in strokes))


def _signature(batch, role, label):
    strokes = getattr(batch, f"{role}_signature_strokes")
    signed_at = getattr(batch, f"{role}_signed_at")
    if not signed_at or not _has_ink(strokes):
        return None
    return {"name": getattr(batch, f"{role}_signature_name") or "",
            "signed_at": signed_at.isoformat(), "strokes": deepcopy(strokes), "source": label,
            "place": batch.customer_signature_place if role == "customer" else None}


def build_group_snapshot(db, site, batches):
    # Import here: the ordinary PDF service also uses MeasurementService.
    from app.services.measurement_pdf_service import MeasurementPdfService, _format_batch_number
    service = MeasurementPdfService(db)
    positions, areas, cells = [], {}, {}
    position_ids = {}
    workers, customers = [], []
    for batch in sorted(batches, key=lambda row: (row.number, row.id)):
        batch_positions, batch_areas, batch_cells, _ = service._build_matrix(batch, mode="current")
        remap = {}
        for item in batch_positions:
            # Deliberately conservative: same number alone is NOT the same service.
            identity = (item.position.strip(), " ".join(item.description.split()), item.unit.strip())
            if identity not in position_ids:
                key = len(positions) + 1
                position_ids[identity] = key
                positions.append({"item_id": key, "position": item.position, "description": item.description,
                                  "unit": item.unit, "sort_order": key})
            remap[item.item_id] = position_ids[identity]
        for area in batch_areas:
            areas.setdefault(area.key, {"key": area.key, "label": area.label})
        for (area, item_id), cell in batch_cells.items():
            key = (area, remap[item_id])
            cells[key] = cells.get(key, Decimal(0)) + cell.quantity
        label = _format_batch_number(site.site_number, batch.number)
        worker = _signature(batch, "worker", label)
        if worker:
            workers.append(worker)
        customers.append(_signature(batch, "customer", label))
    return {
        "positions": positions, "areas": list(areas.values()),
        "cells": [{"area": area, "item_id": item_id, "quantity": str(quantity)}
                  for (area, item_id), quantity in cells.items()],
        "workers": workers, "customer": customers[-1] if all(customers) else None,
        "site": {"customer": site.customer or "-", "name": site.name, "number": site.site_number or "-"},
        "date": datetime.now(timezone.utc).date().isoformat(),
    }


class MeasurementGroupService:
    def __init__(self, db):
        self.db = db

    def _batches(self, site_id, ids=None, lock=False):
        statement = select(SiteMeasurementBatch).where(SiteMeasurementBatch.site_id == site_id).options(
            selectinload(SiteMeasurementBatch.entries).selectinload(SiteMeasurementEntry.measurement_item),
            selectinload(SiteMeasurementBatch.free_items), selectinload(SiteMeasurementBatch.area_rows))
        if ids is not None:
            statement = statement.where(SiteMeasurementBatch.id.in_(ids))
        if lock:
            statement = statement.with_for_update()
        return list(self.db.scalars(statement.order_by(SiteMeasurementBatch.id).execution_options(populate_existing=True)))

    def create(self, site_id, batch_ids, current_user):
        from app.services.measurement_pdf_service import _format_batch_number
        if len(set(batch_ids)) != len(batch_ids) or not 2 <= len(batch_ids) <= 100:
            raise HTTPException(422, "Bitte 2 bis 100 unterschiedliche Aufmaße auswählen.")
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(404, "Baustelle nicht gefunden.")
        # Serializes group creation per site and edits of the selected batches.
        self.db.scalar(select(Site.id).where(Site.id == site_id).with_for_update())
        batches = self._batches(site_id, batch_ids, lock=True)
        if len(batches) != len(batch_ids) or any(batch.deleted_at for batch in batches):
            raise HTTPException(404, "Ein ausgewähltes Aufmaß ist nicht mehr verfügbar.")
        if any(batch.status not in COMPLETED_STATUSES for batch in batches):
            raise HTTPException(409, "Es können nur abgeschlossene Aufmaße zusammengefasst werden.")
        # Release stale memberships from bulk updates, without touching originals.
        groups = list(self.db.scalars(select(MeasurementGroup).where(
            MeasurementGroup.site_id == site_id, MeasurementGroup.invalidated_at.is_(None))))
        if groups:
            all_batches = {batch.id: batch for batch in self._batches(site_id)}
            for group in groups:
                if not group_is_current(group, all_batches):
                    invalidate_groups(self.db.connection(), [source["id"] for source in group.sources])
                elif set(batch_ids) == {source["id"] for source in group.sources}:
                    return group_read(group)  # Safe retry after a lost HTTP response.
        existing = self.db.scalar(select(MeasurementGroupMember.batch_id).where(
            MeasurementGroupMember.batch_id.in_(batch_ids), MeasurementGroupMember.active.is_(True)).limit(1))
        if existing is not None:
            raise HTTPException(409, "Ein ausgewähltes Aufmaß gehört bereits zu einem Gesamtaufmaß.")
        snapshot = build_group_snapshot(self.db, site, batches)
        sources = [{"id": batch.id, "number_label": _format_batch_number(site.site_number, batch.number),
                    "version": source_version(batch)} for batch in sorted(batches, key=lambda row: (row.number, row.id), reverse=True)]
        group = MeasurementGroup(site_id=site_id, number_label=f"{sources[0]['number_label']}G",
            created_by_user_id=current_user.id, sources=sources, snapshot=snapshot,
            position_count=len(snapshot["positions"]), worker_signature_count=len(snapshot["workers"]),
            has_customer_signature=snapshot["customer"] is not None)
        self.db.add(group)
        try:
            self.db.flush()
            self.db.add_all([MeasurementGroupMember(group_id=group.id, batch_id=batch.id, active=True) for batch in batches])
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raise HTTPException(409, "Die Auswahl wurde zwischenzeitlich zusammengefasst. Bitte neu laden.") from None
        return group_read(group)

    def pdf(self, site_id, group_id):
        from app.services.measurement_group_pdf import render_group_pdf
        group = self.db.scalar(select(MeasurementGroup).where(
            MeasurementGroup.id == group_id, MeasurementGroup.site_id == site_id).execution_options(populate_existing=True))
        if group is None:
            raise HTTPException(404, "Gesamtaufmaß nicht gefunden.")
        batches = {batch.id: batch for batch in self._batches(site_id, [source["id"] for source in group.sources], lock=True)}
        if not group_is_current(group, batches):
            raise HTTPException(409, "Ein enthaltenes Aufmaß wurde geändert. Bitte die Aufmaße erneut zusammenfassen.")
        filename = "Gesamtaufmass_" + group.number_label.replace("/", "-").replace(" ", "_") + ".pdf"
        return render_group_pdf(group), filename
