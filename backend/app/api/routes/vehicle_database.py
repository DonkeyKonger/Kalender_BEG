from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin_or_office_page
from app.core.database import get_db
from app.schemas.vehicle_database import (
    VehicleCreate,
    VehicleListQuery,
    VehicleOptionsRead,
    VehicleRead,
    VehicleUpdate,
)
from app.services.vehicle_database_service import VehicleDatabaseService


router = APIRouter(prefix="/admin/vehicles", tags=["vehicle-database"])
CAN_MANAGE = require_admin_or_office_page("miscellaneous")


@router.get("", response_model=list[VehicleRead])
def list_vehicles(
    query: Annotated[VehicleListQuery, Query()],
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> list[VehicleRead]:
    return VehicleDatabaseService(db).list_vehicles(query)


@router.get("/options", response_model=VehicleOptionsRead)
def vehicle_options(
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> VehicleOptionsRead:
    return VehicleDatabaseService(db).options()


@router.get("/{vehicle_id}", response_model=VehicleRead)
def read_vehicle(
    vehicle_id: int,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> VehicleRead:
    return VehicleDatabaseService(db).get_vehicle(vehicle_id)


@router.post("", response_model=VehicleRead, status_code=status.HTTP_201_CREATED)
def create_vehicle(
    payload: VehicleCreate,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> VehicleRead:
    return VehicleDatabaseService(db).create_vehicle(payload)


@router.patch("/{vehicle_id}", response_model=VehicleRead)
def update_vehicle(
    vehicle_id: int,
    payload: VehicleUpdate,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> VehicleRead:
    return VehicleDatabaseService(db).update_vehicle(vehicle_id, payload)


@router.delete("/{vehicle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vehicle(
    vehicle_id: int,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> Response:
    VehicleDatabaseService(db).delete_vehicle(vehicle_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
