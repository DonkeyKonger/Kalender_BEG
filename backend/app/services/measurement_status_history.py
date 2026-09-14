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


def rollback_uses_fallback(batch):
    return batch.status != "submitted" and _recorded_rollback_transition(batch) is None


def rollback_target(batch):
    transition = _recorded_rollback_transition(batch)
    if transition:
        return transition["from"]
    return "submitted" if rollback_uses_fallback(batch) else None


def record_status_transition(batch, target, *, signature_groups=()):
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
    # Keep the superseded signature in the append-only history, not as an active
    # approval. Quantities, locations, worker submissions and invoicing stay intact.
    history.append({
        "kind": "rollback" if transition else "fallback", "from": batch.status, "to": target,
        "at": datetime.now(timezone.utc).isoformat(), "signatures": _signature_state(batch),
        **({"reason": "missing_reliable_history"} if transition is None else {}),
    })
    # Without a trustworthy predecessor, start at submitted without an active
    # customer approval. Its evidence stays in the history above; worker proof,
    # submission snapshots, quantities and invoicing are not reset.
    for group in transition["signature_groups"] if transition else ("customer",):
        for field in SIGNATURE_FIELDS[group]:
            value = deepcopy(transition["signatures"][field]) if transition else None
            if field.endswith("_at") and value:
                value = datetime.fromisoformat(value)
            setattr(batch, field, value)
    batch.status_history = history
    batch.status = target
    return target
