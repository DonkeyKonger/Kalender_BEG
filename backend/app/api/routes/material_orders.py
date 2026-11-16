from urllib.parse import quote

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.dependencies import require_business_page
from app.core.database import get_db
from app.models.user import User
from app.schemas.material_order import (
    MaterialOrderCompleteRead,
    MaterialOrderDraftRead,
    MaterialOrderFormRead,
    MaterialOrderValuesUpdate,
)
from app.services.material_order_graph_runtime import get_material_order_storage_service
from app.services.material_order_service import MaterialOrderService
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService


router = APIRouter(prefix="/sites/{site_id}/material-orders", tags=["material-orders"])
CAN_EDIT_MATERIAL_ORDERS = require_business_page("sites")
MATERIAL_ORDER_FOLDER_KEY = "lagerbestellungen"


def _material_order_folder(db: Session, site_id: int, current_user: User):
    return ProjectFolderService(db).get_project_folder_for_site_by_key(
        site_id,
        MATERIAL_ORDER_FOLDER_KEY,
        current_user,
    )


@router.post("/draft", response_model=MaterialOrderDraftRead)
def open_material_order_draft(
    site_id: int,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> MaterialOrderDraftRead:
    _material_order_folder(db, site_id, current_user)
    return MaterialOrderService(db).open_draft(site_id=site_id, current_user=current_user)


@router.get("/template")
def get_material_order_template_pdf(
    site_id: int,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> Response:
    _material_order_folder(db, site_id, current_user)
    content = MaterialOrderService(db).get_template()
    filename = "Materialschein_Formular_Master.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(filename, safe='')}"},
    )


@router.get("/form", response_model=MaterialOrderFormRead)
def get_material_order_form_descriptor(
    site_id: int,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> MaterialOrderFormRead:
    _material_order_folder(db, site_id, current_user)
    return MaterialOrderFormRead.model_validate(MaterialOrderService(db).get_form())


@router.get("/{draft_id}", response_model=MaterialOrderDraftRead)
def get_material_order_draft(
    site_id: int,
    draft_id: str,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> MaterialOrderDraftRead:
    _material_order_folder(db, site_id, current_user)
    return MaterialOrderService(db).read_draft(
        site_id=site_id,
        draft_id=draft_id,
        current_user=current_user,
    )


@router.put("/{draft_id}", response_model=MaterialOrderDraftRead)
def save_material_order_draft(
    site_id: int,
    draft_id: str,
    payload: MaterialOrderValuesUpdate,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> MaterialOrderDraftRead:
    _material_order_folder(db, site_id, current_user)
    return MaterialOrderService(db).save_draft(
        site_id=site_id,
        draft_id=draft_id,
        current_user=current_user,
        payload=payload,
    )


@router.post("/{draft_id}/preview-pdf")
def preview_material_order_pdf(
    site_id: int,
    draft_id: str,
    payload: MaterialOrderValuesUpdate,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
) -> Response:
    _material_order_folder(db, site_id, current_user)
    content = MaterialOrderService(db).preview_pdf(
        site_id=site_id,
        draft_id=draft_id,
        current_user=current_user,
        payload=payload,
    )
    filename = "Lagerbestellung_Vorschau.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(filename, safe='')}"},
    )


@router.post("/{draft_id}/complete", response_model=MaterialOrderCompleteRead)
def complete_material_order(
    site_id: int,
    draft_id: str,
    payload: MaterialOrderValuesUpdate,
    current_user: User = Depends(CAN_EDIT_MATERIAL_ORDERS),
    db: Session = Depends(get_db),
    storage_service: ProjectStorageService = Depends(get_material_order_storage_service),
) -> MaterialOrderCompleteRead:
    folder = _material_order_folder(db, site_id, current_user)
    return MaterialOrderService(db, storage_service=storage_service).complete(
        site_id=site_id,
        draft_id=draft_id,
        current_user=current_user,
        payload=payload,
        drive_id=folder.external_drive_id,
        folder_item_id=folder.external_item_id,
    )
