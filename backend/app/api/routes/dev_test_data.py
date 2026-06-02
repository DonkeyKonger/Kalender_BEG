from dataclasses import asdict
from datetime import date, timedelta
import random

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import require_admin
from app.core.config import settings
from app.dev.time_gps_test_data import (
    DEFAULT_ERROR_RATE,
    GeneratorOptions,
    clear_time_gps_test_data,
    generate_time_gps_test_data,
    is_time_gps_test_data_allowed,
)
from app.models.user import User
from app.schemas.dev_test_data import (
    TimeGpsTestDataClearResponse,
    TimeGpsTestDataGenerateRequest,
    TimeGpsTestDataGenerateResponse,
    TimeGpsTestDataStatusResponse,
)

router = APIRouter(prefix="/dev/time-gps-test-data", tags=["dev-test-data"])

DISABLED_MESSAGE = "Testdaten-Generator ist in dieser Umgebung deaktiviert."


@router.get("/status", response_model=TimeGpsTestDataStatusResponse)
def get_time_gps_test_data_status(
    _current_user: User = Depends(require_admin),
) -> TimeGpsTestDataStatusResponse:
    enabled = is_time_gps_test_data_allowed()
    return TimeGpsTestDataStatusResponse(
        enabled=enabled,
        environment=settings.environment,
        message=None if enabled else DISABLED_MESSAGE,
    )


@router.post("/generate", response_model=TimeGpsTestDataGenerateResponse, status_code=status.HTTP_201_CREATED)
def generate_time_gps_test_data_batch(
    payload: TimeGpsTestDataGenerateRequest,
    _current_user: User = Depends(require_admin),
) -> TimeGpsTestDataGenerateResponse:
    ensure_generator_enabled()
    start_date, end_date = resolve_api_date_range(payload.start_date, payload.end_date)
    summary = generate_time_gps_test_data(
        GeneratorOptions(
            start_date=start_date,
            end_date=end_date,
            person_count=None,
            site_count=None,
            error_rate=payload.error_rate if payload.error_rate is not None else DEFAULT_ERROR_RATE,
            seed=payload.seed if payload.seed is not None else random.SystemRandom().randint(1, 999_999_999),
            clear_previous_test_data=payload.clear_previous_test_data,
        )
    )
    return TimeGpsTestDataGenerateResponse.model_validate(asdict(summary))


@router.delete("/{batch_id}", response_model=TimeGpsTestDataClearResponse)
def clear_time_gps_test_data_batch(
    batch_id: str,
    _current_user: User = Depends(require_admin),
) -> TimeGpsTestDataClearResponse:
    ensure_generator_enabled()
    deleted_counts = clear_time_gps_test_data(batch_id=batch_id)
    return TimeGpsTestDataClearResponse(batch_id=batch_id, deleted_counts=deleted_counts)


@router.delete("", response_model=TimeGpsTestDataClearResponse)
def clear_all_time_gps_test_data(
    _current_user: User = Depends(require_admin),
) -> TimeGpsTestDataClearResponse:
    ensure_generator_enabled()
    deleted_counts = clear_time_gps_test_data(batch_id=None)
    return TimeGpsTestDataClearResponse(all_test_data=True, deleted_counts=deleted_counts)


def ensure_generator_enabled() -> None:
    if not is_time_gps_test_data_allowed():
        raise HTTPException(status.HTTP_403_FORBIDDEN, DISABLED_MESSAGE)


def resolve_api_date_range(start_date: date | None, end_date: date | None) -> tuple[date, date]:
    if start_date is None and end_date is None:
        today = date.today()
        start_date = today - timedelta(days=today.weekday())
        end_date = start_date + timedelta(days=6)
    elif start_date is None:
        start_date = end_date
    elif end_date is None:
        end_date = start_date

    if start_date is None or end_date is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zeitraum konnte nicht bestimmt werden.")
    if end_date < start_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "end_date darf nicht vor start_date liegen.")
    return start_date, end_date
