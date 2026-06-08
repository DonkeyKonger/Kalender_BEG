from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import require_admin
from app.models.user import User
from app.services.ctrack_client import CtrackClient, CtrackConfigError, CtrackRequestError

router = APIRouter(prefix="/admin/integrations/ctrack", tags=["admin-integrations"])


@router.get("/vehicles")
def get_ctrack_vehicles(_current_user: User = Depends(require_admin)) -> Any:
    return _run_ctrack_call(CtrackClient().get_vehicles)


@router.get("/positions/latest")
def get_ctrack_latest_positions(_current_user: User = Depends(require_admin)) -> Any:
    return _run_ctrack_call(CtrackClient().get_latest_positions)


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
