from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin, require_admin_or_office_page
from app.core.database import get_db
from app.schemas.tool_material_item import (
    ToolMaterialFilterOptionsRead,
    ToolMaterialItemCreate,
    ToolMaterialItemRead,
    ToolMaterialItemUpdate,
    ToolMaterialListQuery,
    ToolMaterialResponsibilityRead,
    ToolMaterialResponsibilityUpdate,
    ToolResponsibleUserRead,
)
from app.services.tool_material_responsibility_service import (
    ToolMaterialResponsibilityService,
)
from app.services.tool_material_service import ToolMaterialService

router = APIRouter(prefix="/admin/tool-material-items", tags=["tool-material-items"])
CAN_MANAGE = require_admin_or_office_page("miscellaneous")


@router.get("", response_model=list[ToolMaterialItemRead])
def list_tool_material_items(
    query: Annotated[ToolMaterialListQuery, Query()],
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> list[ToolMaterialItemRead]:
    service = ToolMaterialService(db)
    return [ToolMaterialItemRead.model_validate(item) for item in service.list_items(query)]


@router.get("/filter-options", response_model=ToolMaterialFilterOptionsRead)
def list_tool_material_filter_options(
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> ToolMaterialFilterOptionsRead:
    return ToolMaterialService(db).filter_options()


@router.get("/responsibility", response_model=ToolMaterialResponsibilityRead)
def read_tool_material_responsibility(
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> ToolMaterialResponsibilityRead:
    return ToolMaterialResponsibilityService(db).read_settings()


@router.get("/responsibility/options", response_model=list[ToolResponsibleUserRead])
def list_tool_material_responsible_user_options(
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[ToolResponsibleUserRead]:
    return ToolMaterialResponsibilityService(db).list_selectable_users()


@router.put("/responsibility", response_model=ToolMaterialResponsibilityRead)
def update_tool_material_responsibility(
    payload: ToolMaterialResponsibilityUpdate,
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> ToolMaterialResponsibilityRead:
    return ToolMaterialResponsibilityService(db).update_responsible_user(
        payload.tool_responsible_user_id
    )


@router.post("", response_model=ToolMaterialItemRead, status_code=status.HTTP_201_CREATED)
def create_tool_material_item(
    payload: ToolMaterialItemCreate,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> ToolMaterialItemRead:
    item = ToolMaterialService(db).create_item(payload)
    return ToolMaterialItemRead.model_validate(item)


@router.patch("/{item_id}", response_model=ToolMaterialItemRead)
def update_tool_material_item(
    item_id: int,
    payload: ToolMaterialItemUpdate,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> ToolMaterialItemRead:
    item = ToolMaterialService(db).update_item(item_id, payload)
    return ToolMaterialItemRead.model_validate(item)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tool_material_item(
    item_id: int,
    _user=Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> Response:
    ToolMaterialService(db).delete_item(item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
