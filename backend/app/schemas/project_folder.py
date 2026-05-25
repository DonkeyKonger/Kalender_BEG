from datetime import datetime

from pydantic import BaseModel


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
