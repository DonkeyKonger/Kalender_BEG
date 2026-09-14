"""Batch-local position metadata shared by the editor, snapshots and PDF export."""


def measurement_item_content(item, batch):
    fields = {name: getattr(item, name) for name in (
        "position", "description", "unit", "linked_measurement_item_id",
    )}
    fields.update((batch.item_overrides or {}).get(str(item.id), {}))
    return fields


def measurement_item_minutes(item, batch):
    fields = measurement_item_content(item, batch)
    if fields["linked_measurement_item_id"] != item.linked_measurement_item_id or fields["position"] != item.position:
        return None  # Resolve the changed billing position, never use the old rate.
    return item.minutes_per_unit
