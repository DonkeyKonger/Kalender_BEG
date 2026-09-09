from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class ProjectSubfolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_item_id: str | None = Field(default=None, min_length=1, max_length=512)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name or name.endswith(".") or any(
            char in '\\/:*?"<>|' or ord(char) < 32 for char in name
        ):
            raise ValueError("Bitte einen gültigen Ordnernamen ohne Sonderzeichen oder abschließenden Punkt eingeben.")
        return name


class ProjectFolderRead(BaseModel):
    id: int
    site_id: int
    sort_order: int
    name: str
    folder_key: str
    is_active: bool
    external_provider: str | None = None
    external_drive_id: str | None = None
    external_item_id: str | None = None
    external_web_url: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ProjectFolderDocumentItem(BaseModel):
    id: str
    name: str
    web_url: str | None = None
    size: int | None = None
    created_date_time: str | None = None
    last_modified_date_time: str | None = None
    mime_type: str | None = None
    file_extension: str | None = None
    is_folder: bool = False
    caption: str | None = None


class ProjectFolderDocumentList(BaseModel):
    folder_key: str
    folder_name: str
    items: list[ProjectFolderDocumentItem]
