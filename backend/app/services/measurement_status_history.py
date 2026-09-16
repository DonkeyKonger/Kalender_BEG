"""Persist actual transitions, not a synthetic linear sequence of approvals."""
from copy import deepcopy
from datetime import datetime, timezone

from fastapi import HTTPException


SIGNATURE_FIELDS = {
    "customer": ("customer_signed_at", "customer_signature_name", "customer_signature_place", "customer_signature_strokes", "customer_signed_snapshot"),
    "worker": ("worker_signed_at", "worker_signature_name", "worker_signature_strokes"),
}

SIGNED_STATUSES = {"customer_signed", "signed"}
COMPLETED_STATUSES = {"billed", "approved", "closed", "completed", "finalized", "abgeschlossen"}


def has_signature_barrier(batch, *, signed_snapshot_present=None):
    """Once signed, even legacy records may never regress below that stage."""
    if batch.status in SIGNED_STATUSES or batch.customer_signed_at or batch.customer_signature_name:
        return True
    # List queries pass an existence flag rather than loading the large snapshot.
    if signed_snapshot_present is None:
        signed_snapshot_present = batch.customer_signed_snapshot is not None
    if signed_snapshot_present:
        return True
    for event in batch.status_history or []:
        if not isinstance(event, dict):
            continue
        if event.get("from") in ("customer_signed", "signed") or event.get("to") in ("customer_signed", "signed"):
            return True
        signatures = event.get("signatures")
        if isinstance(signatures, dict) and any(signatures.get(field) for field in SIGNATURE_FIELDS["customer"]):
            return True
    return False


def ensure_signature_barrier(batch, target):
    if has_signature_barrier(batch) and target not in SIGNED_STATUSES | COMPLETED_STATUSES:
        raise HTTPException(409, "Unterschriebene Aufmaße können nicht unter den Status Unterschrieben zurückgesetzt werden.")


def _signature_state(batch):
    return {
        field: value.isoformat() if isinstance(value, datetime) else deepcopy(value)
        for fields in SIGNATURE_FIELDS.values()
        for field in fields
        for value in [getattr(batch, field)]
    }


def active_transitions(batch):
    stack = []
    for event in batch.status_history or []:
        if not isinstance(event, dict):
            stack = []
        elif event.get("kind") == "advance" and _valid_transition(event):
            if stack and stack[-1]["to"] != event["from"]:
                stack = []
            stack.append(event)
        elif (event.get("kind") == "rollback" and stack
              and event.get("from") == stack[-1]["to"]
              and event.get("to") == stack[-1]["from"]):
            stack.pop()
        else:
            stack = []
    return stack


def _valid_transition(event):
    if not all(isinstance(event.get(key), str) and event[key] for key in ("from", "to")):
        return False
    groups, signatures = event.get("signature_groups"), event.get("signatures")
    if not isinstance(groups, list) or not isinstance(signatures, dict):
        return False
    for group in groups:
        if not isinstance(group, str) or group not in SIGNATURE_FIELDS:
            return False
        for field in SIGNATURE_FIELDS[group]:
            if field not in signatures:
                return False
            if field.endswith("_at") and signatures[field] is not None:
                try:
                    datetime.fromisoformat(signatures[field])
                except (TypeError, ValueError):
                    return False
    return event["from"] != event["to"]


def _recorded_rollback_transition(batch):
    stack = active_transitions(batch)
    if not stack or stack[-1]["to"] != batch.status:
        return None
    target = stack[-1]["from"]
    # A status string or a worker lock is not proof of a customer signature.
    proof = (stack[-1]["signatures"].get("customer_signed_at")
             if "customer" in stack[-1]["signature_groups"] else batch.customer_signed_at)
    if target in {"customer_signed", "signed"} and not proof:
        return None
    return stack[-1]


def rollback_uses_fallback(batch, *, signature_barrier=None):
    target = rollback_target(batch, signature_barrier=signature_barrier)
    transition = _recorded_rollback_transition(batch)
    return target is not None and (transition is None or transition["from"] != target)


def rollback_target(batch, *, signature_barrier=None):
    if signature_barrier is None:
        signature_barrier = has_signature_barrier(batch)
    if signature_barrier:
        # Never invent a missing signature from a status label or old history.
        return "customer_signed" if batch.status in COMPLETED_STATUSES and batch.customer_signed_at else None
    if batch.status == "draft":
        return None
    transition = _recorded_rollback_transition(batch)
    if transition:
        return transition["from"]
    return "draft" if batch.status == "submitted" else "submitted"


def record_status_transition(batch, target, *, signature_groups=()):
    ensure_signature_barrier(batch, target)
    if batch.status == target:
        return
    history = list(batch.status_history or [])
    if history and (not isinstance(history[-1], dict) or history[-1].get("to") != batch.status):
        history.append({"kind": "baseline", "to": batch.status})
    history.append({
        "kind": "advance", "from": batch.status, "to": target,
        "at": datetime.now(timezone.utc).isoformat(),
        "signature_groups": list(signature_groups), "signatures": _signature_state(batch),
    })
    batch.status_history = history


def rollback_status(batch, expected_revision):
    history = list(batch.status_history or [])
    if expected_revision != len(history):
        raise HTTPException(409, "Der Status wurde zwischenzeitlich geändert. Bitte Aufmaß neu öffnen.")
    target = rollback_target(batch)
    if target is None:
        raise HTTPException(409, "Kein verlässlich protokollierter vorheriger Status vorhanden.")
    transition = _recorded_rollback_transition(batch)
    if transition and transition["from"] != target:
        transition = None
    # Preserve the audit trail. Quantities, locations and invoicing stay intact.
    history.append({
        "kind": "rollback" if transition else "fallback", "from": batch.status, "to": target,
        "at": datetime.now(timezone.utc).isoformat(), "signatures": _signature_state(batch),
        **({"reason": "missing_reliable_history"} if transition is None else {}),
    })
    # A signed batch always retains its active signature and signed snapshot.
    # Only unsigned batches may restore signature fields from their predecessor.
    groups_to_restore = transition["signature_groups"] if transition else ("customer",)
    if has_signature_barrier(batch):
        groups_to_restore = ()
    for group in groups_to_restore:
        for field in SIGNATURE_FIELDS[group]:
            value = deepcopy(transition["signatures"][field]) if transition else None
            if field.endswith("_at") and value:
                value = datetime.fromisoformat(value)
            setattr(batch, field, value)
    batch.status_history = history
    batch.status = target
    return target
