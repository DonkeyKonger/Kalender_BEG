from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import String, case, cast, false, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.models.person import Person
from app.models.enums import ToolMaterialStatus
from app.models.tool_material_item import ToolMaterialItem
from app.schemas.tool_material_item import (
    ToolMaterialFilterOption,
    ToolMaterialFilterOptionsRead,
    ToolMaterialItemCreate,
    ToolMaterialItemUpdate,
    ToolMaterialListQuery,
)


EMPTY_FILTER_VALUE = "__empty__"
TEXT_FIELDS = [
    "beg_number",
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
TEXT_FILTER_COLUMNS = {
    "beg_number": ToolMaterialItem.beg_number,
    "manufacturer": ToolMaterialItem.manufacturer,
    "designation": ToolMaterialItem.designation,
    "item_type": ToolMaterialItem.item_type,
    "device_number": ToolMaterialItem.device_number,
    "serial_number": ToolMaterialItem.serial_number,
    "delivery_note": ToolMaterialItem.delivery_note,
    "remarks": ToolMaterialItem.remarks,
    "supplier": ToolMaterialItem.supplier,
    "invoice_number": ToolMaterialItem.invoice_number,
}
SORT_COLUMNS = {
    **TEXT_FILTER_COLUMNS,
    "employee": Person.display_name,
    "item_date": ToolMaterialItem.item_date,
    "stock": ToolMaterialItem.stock,
    "status": ToolMaterialItem.status,
}

STATUS_LABELS = {
    ToolMaterialStatus.ISSUED.value: "Ausgegeben",
    ToolMaterialStatus.WAREHOUSE.value: "Lager",
    ToolMaterialStatus.DEFECTIVE.value: "Defekt",
}


class ToolMaterialService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_items(self, query: ToolMaterialListQuery | None = None) -> list[ToolMaterialItem]:
        filters = query or ToolMaterialListQuery()
        statement = (
            select(ToolMaterialItem)
            .outerjoin(ToolMaterialItem.employee)
            .options(joinedload(ToolMaterialItem.employee))
        )
        cleaned_search = clean_search(filters.search)
        if cleaned_search:
            needle = f"%{cleaned_search}%"
            statement = statement.where(
                or_(
                    *(column.ilike(needle) for column in TEXT_FILTER_COLUMNS.values()),
                    Person.display_name.ilike(needle),
                    Person.short_code.ilike(needle),
                    cast(ToolMaterialItem.item_date, String).ilike(needle),
                    cast(ToolMaterialItem.stock, String).ilike(needle),
                    cast(ToolMaterialItem.status, String).ilike(needle),
                )
            )

        for field, column in TEXT_FILTER_COLUMNS.items():
            text_filter = clean_search(getattr(filters, f"filter_{field}"))
            if text_filter:
                statement = statement.where(column.ilike(f"%{text_filter}%"))
            selected_values = getattr(filters, f"values_{field}")
            if selected_values:
                statement = statement.where(selected_values_condition(column, selected_values))

        employee_filter = clean_search(filters.filter_employee)
        if employee_filter:
            employee_needle = f"%{employee_filter}%"
            statement = statement.where(
                or_(
                    Person.display_name.ilike(employee_needle),
                    Person.short_code.ilike(employee_needle),
                )
            )
        if filters.values_employee:
            statement = statement.where(employee_values_condition(filters.values_employee))

        if filters.values_item_date:
            statement = statement.where(date_values_condition(filters.values_item_date))
        if filters.date_from is not None:
            statement = statement.where(ToolMaterialItem.item_date >= filters.date_from)
        if filters.date_to is not None:
            statement = statement.where(ToolMaterialItem.item_date <= filters.date_to)

        if filters.values_stock:
            statement = statement.where(stock_values_condition(filters.values_stock))
        if filters.stock_min is not None:
            statement = statement.where(ToolMaterialItem.stock >= filters.stock_min)
        if filters.stock_max is not None:
            statement = statement.where(ToolMaterialItem.stock <= filters.stock_max)

        if filters.values_status:
            statement = statement.where(ToolMaterialItem.status.in_(filters.values_status))

        sort_column = SORT_COLUMNS[filters.sort_by]
        normalized_sort_column = func.lower(sort_column) if filters.sort_by not in {"item_date", "stock"} else sort_column
        direction = normalized_sort_column.desc() if filters.sort_direction == "desc" else normalized_sort_column.asc()
        statement = statement.order_by(
            case((sort_column.is_(None), 1), else_=0),
            direction,
            ToolMaterialItem.id,
        )
        return list(self.db.scalars(statement).unique())

    def filter_options(self) -> ToolMaterialFilterOptionsRead:
        rows = self.db.execute(
            select(
                ToolMaterialItem.beg_number,
                ToolMaterialItem.manufacturer,
                ToolMaterialItem.designation,
                ToolMaterialItem.item_type,
                ToolMaterialItem.device_number,
                ToolMaterialItem.serial_number,
                ToolMaterialItem.employee_id,
                Person.display_name,
                ToolMaterialItem.item_date,
                ToolMaterialItem.delivery_note,
                ToolMaterialItem.remarks,
                ToolMaterialItem.supplier,
                ToolMaterialItem.invoice_number,
                ToolMaterialItem.stock,
                ToolMaterialItem.status,
            ).outerjoin(ToolMaterialItem.employee)
        ).all()
        option_maps: dict[str, dict[str, str]] = {
            key: {}
            for key in (
                "beg_number",
                "manufacturer",
                "designation",
                "item_type",
                "device_number",
                "serial_number",
                "employee",
                "item_date",
                "delivery_note",
                "remarks",
                "supplier",
                "invoice_number",
                "stock",
                "status",
            )
        }
        for row in rows:
            for field in TEXT_FILTER_COLUMNS:
                add_filter_option(option_maps[field], getattr(row, field))
            add_filter_option(
                option_maps["employee"],
                row.employee_id,
                label=row.display_name,
            )
            add_filter_option(
                option_maps["item_date"],
                row.item_date.isoformat() if row.item_date else None,
                label=row.item_date.strftime("%d.%m.%Y") if row.item_date else None,
            )
            add_filter_option(option_maps["stock"], row.stock)
            add_filter_option(
                option_maps["status"],
                row.status.value if isinstance(row.status, ToolMaterialStatus) else row.status,
                label=STATUS_LABELS.get(
                    row.status.value if isinstance(row.status, ToolMaterialStatus) else row.status,
                ),
            )

        return ToolMaterialFilterOptionsRead(
            columns={
                field: [
                    ToolMaterialFilterOption(value=value, label=label)
                    for value, label in sorted(
                        values.items(),
                        key=lambda entry: (entry[0] == EMPTY_FILTER_VALUE, entry[1].casefold()),
                    )
                ]
                for field, values in option_maps.items()
            }
        )

    def create_item(self, payload: ToolMaterialItemCreate) -> ToolMaterialItem:
        values = clean_tool_material_values(payload.model_dump())
        values = enforce_status_employee_consistency(
            values,
            provided_fields=payload.model_fields_set,
        )
        self._ensure_unique_beg_number(values["beg_number"])
        self._ensure_employee_exists(values.get("employee_id"))
        item = ToolMaterialItem(**values)
        self.db.add(item)
        self._commit_with_unique_beg_number_guard()
        self.db.refresh(item)
        return self._get_item(item.id)

    def update_item(self, item_id: int, payload: ToolMaterialItemUpdate) -> ToolMaterialItem:
        item = self._get_item(item_id)
        values = clean_tool_material_values(payload.model_dump(exclude_unset=True), partial=True)
        values = enforce_status_employee_consistency(
            values,
            provided_fields=payload.model_fields_set,
            current_status=item.status,
        )
        if "beg_number" in values and values["beg_number"] is not None:
            self._ensure_unique_beg_number(values["beg_number"], excluding_item_id=item_id)
        if "employee_id" in values:
            self._ensure_employee_exists(values.get("employee_id"))
        for field, value in values.items():
            setattr(item, field, value)
        self._commit_with_unique_beg_number_guard()
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

    def _ensure_unique_beg_number(self, beg_number: str, *, excluding_item_id: int | None = None) -> None:
        statement = select(ToolMaterialItem.id).where(func.lower(ToolMaterialItem.beg_number) == beg_number.lower())
        if excluding_item_id is not None:
            statement = statement.where(ToolMaterialItem.id != excluding_item_id)
        if self.db.scalar(statement) is not None:
            raise duplicate_beg_number_error()

    def _commit_with_unique_beg_number_guard(self) -> None:
        try:
            self.db.commit()
        except IntegrityError as error:
            self.db.rollback()
            raise duplicate_beg_number_error() from error


def clean_tool_material_values(values: dict, *, partial: bool = False) -> dict:
    cleaned = dict(values)
    for field in TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if not partial and not cleaned.get("beg_number"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "BEG-Nr. darf nicht leer sein.")
    if not partial and not cleaned.get("designation"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bezeichnung darf nicht leer sein.")
    if "designation" in cleaned and not cleaned.get("designation"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bezeichnung darf nicht leer sein.")
    return cleaned


def enforce_status_employee_consistency(
    values: dict,
    *,
    provided_fields: set[str],
    current_status: ToolMaterialStatus | None = None,
) -> dict:
    normalized = dict(values)
    status_value = normalized.get("status", current_status or ToolMaterialStatus.WAREHOUSE)
    employee_id = normalized.get("employee_id")
    status_was_provided = "status" in provided_fields
    employee_was_provided = "employee_id" in provided_fields
    unassigned_statuses = {
        ToolMaterialStatus.WAREHOUSE,
        ToolMaterialStatus.DEFECTIVE,
    }

    if (
        status_was_provided
        and employee_was_provided
        and employee_id is not None
        and status_value in unassigned_statuses
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Lager- oder defekte Einträge dürfen keinem Mitarbeiter zugeordnet sein.",
        )

    if status_was_provided and status_value in unassigned_statuses:
        normalized["employee_id"] = None
    elif employee_was_provided and employee_id is not None:
        normalized["status"] = ToolMaterialStatus.ISSUED
    elif (
        employee_was_provided
        and employee_id is None
        and not status_was_provided
        and current_status == ToolMaterialStatus.ISSUED
    ):
        normalized["status"] = ToolMaterialStatus.WAREHOUSE

    return normalized


def clean_search(value: str | None) -> str:
    return value.strip() if isinstance(value, str) else ""


def selected_values_condition(column, values: list[str]):
    selected = [value for value in values if value != EMPTY_FILTER_VALUE]
    conditions = []
    if selected:
        conditions.append(column.in_(selected))
    if EMPTY_FILTER_VALUE in values:
        conditions.extend((column.is_(None), column == ""))
    return or_(*conditions) if conditions else false()


def employee_values_condition(values: list[str]):
    employee_ids = [int(value) for value in values if value.isdigit()]
    conditions = []
    if employee_ids:
        conditions.append(ToolMaterialItem.employee_id.in_(employee_ids))
    if EMPTY_FILTER_VALUE in values:
        conditions.append(ToolMaterialItem.employee_id.is_(None))
    return or_(*conditions) if conditions else false()


def date_values_condition(values: list[str]):
    parsed_dates: list[date] = []
    for value in values:
        if value == EMPTY_FILTER_VALUE:
            continue
        try:
            parsed_dates.append(date.fromisoformat(value))
        except ValueError:
            continue
    conditions = []
    if parsed_dates:
        conditions.append(ToolMaterialItem.item_date.in_(parsed_dates))
    if EMPTY_FILTER_VALUE in values:
        conditions.append(ToolMaterialItem.item_date.is_(None))
    return or_(*conditions) if conditions else false()


def stock_values_condition(values: list[str]):
    stock_values = [int(value) for value in values if value.isdigit()]
    conditions = []
    if stock_values:
        conditions.append(ToolMaterialItem.stock.in_(stock_values))
    if EMPTY_FILTER_VALUE in values:
        conditions.append(ToolMaterialItem.stock.is_(None))
    return or_(*conditions) if conditions else false()


def add_filter_option(options: dict[str, str], value, *, label: str | None = None) -> None:
    option_value = EMPTY_FILTER_VALUE if value is None or value == "" else str(value)
    option_label = "(Leer)" if option_value == EMPTY_FILTER_VALUE else (label or str(value))
    options[option_value] = option_label


def duplicate_beg_number_error() -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, "Diese BEG-Nr. ist bereits vergeben.")
