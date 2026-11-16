from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, StrictBool, StrictStr, field_validator

from app.schemas.project_folder import ProjectFolderDocumentItem


MaterialOrderValue = StrictStr | StrictBool


class MaterialOrderValuesUpdate(BaseModel):
    revision: int = Field(ge=0)
    values: dict[str, MaterialOrderValue]

    @field_validator("values")
    @classmethod
    def validate_values_size(
        cls,
        values: dict[str, MaterialOrderValue],
    ) -> dict[str, MaterialOrderValue]:
        if len(values) > 200:
            raise ValueError("Das Formular enthält zu viele Felder.")
        for name, value in values.items():
            if not name or len(name) > 100:
                raise ValueError("Das Formular enthält einen ungültigen Feldnamen.")
            if isinstance(value, str) and len(value) > 5000:
                raise ValueError(f"Der Wert für {name} ist zu lang.")
        return values


class MaterialOrderDraftRead(BaseModel):
    id: str
    site_id: int
    revision: int
    values: dict[str, str | bool]
    status: Literal["draft", "completed"]
    filename: str | None = None
    completion_pending: bool = False
    document: ProjectFolderDocumentItem | None = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class MaterialOrderFormFieldRead(BaseModel):
    name: str
    label: str
    type: Literal["text", "checkbox"]
    rect: tuple[float, float, float, float]
    max_length: int | None = Field(default=None, ge=1)


class MaterialOrderFormRead(BaseModel):
    width: float
    height: float
    fields: list[MaterialOrderFormFieldRead]


class MaterialOrderCompleteRead(BaseModel):
    draft: MaterialOrderDraftRead
    document: ProjectFolderDocumentItem
