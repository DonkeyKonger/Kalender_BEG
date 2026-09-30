from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.warehouse import (
    Direction, WarehouseMovementCreate, WarehousePersonRead, WarehouseReceiptRead, WarehouseToolPage,
    WarehouseToolRead,
)
from app.services.warehouse_service import WarehouseService

router = APIRouter(prefix="/warehouse", tags=["warehouse"])
CAN_USE_WAREHOUSE = require_roles(UserRole.WAREHOUSE)


@router.get("/people", response_model=list[WarehousePersonRead])
def people(direction: Direction, _user=Depends(CAN_USE_WAREHOUSE), db: Session = Depends(get_db)):
    return WarehouseService(db).people(direction)


@router.get("/tools", response_model=WarehouseToolPage)
def tools(
    direction: Direction, employee_id: int = Query(gt=0), search: str = Query(default="", max_length=160),
    offset: int = Query(default=0, ge=0), limit: int = Query(default=40, ge=1, le=100),
    _user=Depends(CAN_USE_WAREHOUSE), db: Session = Depends(get_db),
):
    items, total = WarehouseService(db).tools(direction, employee_id, search, offset, limit)
    return WarehouseToolPage(items=[WarehouseToolRead.model_validate(item) for item in items], total=total)


@router.post("/movements", response_model=WarehouseReceiptRead, status_code=201)
def book(payload: WarehouseMovementCreate, user=Depends(CAN_USE_WAREHOUSE), db: Session = Depends(get_db)):
    return WarehouseService(db).book(payload, user)
