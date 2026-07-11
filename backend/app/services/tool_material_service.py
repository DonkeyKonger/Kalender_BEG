from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.schemas.tool_material_item import ToolMaterialItemCreate, ToolMaterialItemUpdate


TEXT_FIELDS = [
    "manufacturer",
    "designation",
    "item_type",
    "device_number",
    "serial_number",
    "delivery_note",
    "remarks",
    "supplier",
    "invoice_number",
]


class ToolMaterialService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_items(self, search: str | None = None) -> list[ToolMaterialItem]:
        statement = select(ToolMaterialItem).options(joinedload(ToolMaterialItem.employee))
        cleaned_search = search.strip() if isinstance(search, str) else ""
        if cleaned_search:
            needle = f"%{cleaned_search}%"
            statement = statement.outerjoin(ToolMaterialItem.employee).where(
                or_(
                    ToolMaterialItem.manufacturer.ilike(needle),
                    ToolMaterialItem.designation.ilike(needle),
                    ToolMaterialItem.item_type.ilike(needle),
                    ToolMaterialItem.device_number.ilike(needle),
                    ToolMaterialItem.serial_number.ilike(needle),
                    ToolMaterialItem.supplier.ilike(needle),
                    ToolMaterialItem.invoice_number.ilike(needle),
                    Person.display_name.ilike(needle),
                    Person.short_code.ilike(needle),
                )
            )
        statement = statement.order_by(ToolMaterialItem.designation, ToolMaterialItem.id)
        return list(self.db.scalars(statement).unique())

    def create_item(self, payload: ToolMaterialItemCreate) -> ToolMaterialItem:
        values = clean_tool_material_values(payload.model_dump())
        self._ensure_employee_exists(values.get("employee_id"))
        item = ToolMaterialItem(**values)
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return self._get_item(item.id)

    def update_item(self, item_id: int, payload: ToolMaterialItemUpdate) -> ToolMaterialItem:
        item = self._get_item(item_id)
        values = clean_tool_material_values(payload.model_dump(exclude_unset=True), partial=True)
        if "employee_id" in values:
            self._ensure_employee_exists(values.get("employee_id"))
        for field, value in values.items():
            setattr(item, field, value)
        self.db.commit()
        self.db.refresh(item)
        return self._get_item(item.id)

    def delete_item(self, item_id: int) -> None:
        item = self._get_item(item_id)
        self.db.delete(item)
        self.db.commit()

    def _get_item(self, item_id: int) -> ToolMaterialItem:
        statement = (
            select(ToolMaterialItem)
            .options(joinedload(ToolMaterialItem.employee))
            .where(ToolMaterialItem.id == item_id)
        )
        item = self.db.scalar(statement)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Eintrag nicht gefunden.")
        return item

    def _ensure_employee_exists(self, employee_id: int | None) -> None:
        if employee_id is None:
            return
        person = self.db.get(Person, employee_id)
        if person is None or person.deleted_at is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mitarbeiter nicht gefunden.")


def clean_tool_material_values(values: dict, *, partial: bool = False) -> dict:
    cleaned = dict(values)
    for field in TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if not partial and not cleaned.get("designation"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bezeichnung darf nicht leer sein.")
    if "designation" in cleaned and not cleaned.get("designation"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bezeichnung darf nicht leer sein.")
    return cleaned
