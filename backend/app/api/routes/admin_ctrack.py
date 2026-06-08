from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db, require_admin
from app.models.user import User
from app.services.ctrack_client import (
    CtrackClient,
    CtrackConfigError,
    CtrackRequestError,
    CtrackVehicleSyncService,
)

router = APIRouter(prefix="/admin/integrations/ctrack", tags=["admin-integrations"])
integration_router = APIRouter(prefix="/integrations/ctrack", tags=["vehicle-integrations"])
vehicles_router = APIRouter(prefix="/vehicles", tags=["vehicles"])


@router.get("/vehicles")
def get_ctrack_vehicles(_current_user: User = Depends(require_admin)) -> Any:
    return _run_ctrack_call(CtrackClient().get_vehicles)


@router.get("/positions/latest")
def get_ctrack_latest_positions(_current_user: User = Depends(require_admin)) -> Any:
    return _run_ctrack_call(CtrackClient().get_latest_positions)


@integration_router.post("/sync-now")
def sync_ctrack_now(
    _current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    return _run_ctrack_call(lambda: CtrackVehicleSyncService(db).sync_now())


@vehicles_router.get("")
def list_vehicle_assets(
    _current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    return CtrackVehicleSyncService(db).list_vehicle_assets()


@vehicles_router.get("/latest-positions")
def list_vehicle_latest_positions(
    _current_user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    return CtrackVehicleSyncService(db).list_latest_positions()


def _run_ctrack_call(callback: Callable[[], Any]) -> Any:
    try:
        return callback()
    except CtrackConfigError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "message": "Ctrack API is not configured.",
                "missing_config": error.missing_config,
            },
        ) from error
    except CtrackRequestError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error
