from datetime import datetime

from pydantic import BaseModel

from app.models.enums import UserRole


class UserRead(BaseModel):
    id: int
    username: str
    display_name: str
    role: UserRole
    is_active: bool
    person_id: int | None = None
    last_login_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
