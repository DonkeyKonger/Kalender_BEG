"""Persist actual transitions, not a synthetic linear sequence of approvals."""
from copy import deepcopy
from datetime import datetime, timezone

from fastapi import HTTPException


SIGNATURE_FIELDS = {
    "customer": ("customer_signed_at", "customer_signature_name", "customer_signature_place", "customer_signature_strokes", "customer_signed_snapshot"),
    "worker": ("worker_signed_at", "worker_signature_name", "worker_signature_strokes"),
}


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
        if event["kind"] == "advance":
            stack.append(event)
        elif event["kind"] == "rollback" and stack:
            stack.pop()
        else:
            stack = []
    return stack


def rollback_target(batch):
    stack = active_transitions(batch)
    if not stack or stack[-1]["to"] != batch.status:
        return None
    target = stack[-1]["from"]
    # A status string or a worker lock is not proof of a customer signature.
    proof = (stack[-1]["signatures"].get("customer_signed_at")
             if "customer" in stack[-1]["signature_groups"] else batch.customer_signed_at)
    if target in {"customer_signed", "signed"} and not proof:
        return None
    return target


def record_status_transition(batch, target, *, signature_groups=()):
    if batch.status == target:
        return
    history = list(batch.status_history or [])
    if history and history[-1]["to"] != batch.status:
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
    transition = active_transitions(batch)[-1]
    # Keep the superseded signature in the append-only history, not as an active
    # approval. Quantities, locations, worker submissions and invoicing stay intact.
    history.append({
        "kind": "rollback", "from": batch.status, "to": target,
        "at": datetime.now(timezone.utc).isoformat(), "signatures": _signature_state(batch),
    })
    for group in transition["signature_groups"]:
        for field in SIGNATURE_FIELDS[group]:
            value = deepcopy(transition["signatures"][field])
            if field.endswith("_at") and value:
                value = datetime.fromisoformat(value)
            setattr(batch, field, value)
    batch.status_history = history
    batch.status = target
    return target
