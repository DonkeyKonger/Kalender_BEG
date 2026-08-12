from fastapi import HTTPException, status


MEASUREMENT_MANUAL_STATUS_TARGETS = ("submitted", "reviewed", "billed")
EXTRA_WORK_MANUAL_STATUS_TARGETS = ("submitted", "billed")

_MEASUREMENT_STATUS_RANK = {
    "draft": 0,
    "submitted": 1,
    "in_review": 1,
    "rejected": 1,
    "reviewed": 2,
    "checked": 2,
    "customer_signed": 3,
    "signed": 3,
    "billed": 4,
    "approved": 4,
    "closed": 4,
    "completed": 4,
    "finalized": 4,
    "abgeschlossen": 4,
}

_EXTRA_WORK_STATUS_RANK = {
    "draft": 0,
    "submitted": 1,
    "reviewed": 1,
    "signed": 2,
    "customer_signed": 2,
    "billed": 3,
    "approved": 3,
    "closed": 3,
    "completed": 3,
    "finalized": 3,
    "abgeschlossen": 3,
}


def validate_measurement_status_promotion(current_status: str, target_status: str) -> str:
    return _validate_promotion(
        current_status=current_status,
        target_status=target_status,
        allowed_targets=MEASUREMENT_MANUAL_STATUS_TARGETS,
        ranks=_MEASUREMENT_STATUS_RANK,
        entity_label="Aufmaß",
    )


def validate_extra_work_status_promotion(current_status: str, target_status: str) -> str:
    return _validate_promotion(
        current_status=current_status,
        target_status=target_status,
        allowed_targets=EXTRA_WORK_MANUAL_STATUS_TARGETS,
        ranks=_EXTRA_WORK_STATUS_RANK,
        entity_label="Zusatzauftrag",
    )


def _validate_promotion(
    *,
    current_status: str,
    target_status: str,
    allowed_targets: tuple[str, ...],
    ranks: dict[str, int],
    entity_label: str,
) -> str:
    normalized_current = (current_status or "").strip().lower()
    normalized_target = (target_status or "").strip().lower()
    if normalized_target not in allowed_targets:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Dieser Status darf nicht manuell gesetzt werden.",
        )
    current_rank = ranks.get(normalized_current)
    target_rank = ranks.get(normalized_target)
    if current_rank is None or target_rank is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Der aktuelle Status des {entity_label}s kann nicht manuell aufgewertet werden.",
        )
    if target_rank <= current_rank:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Statusänderungen sind ausschließlich auf einen höheren Status erlaubt.",
        )
    return normalized_target
