from datetime import datetime

from pydantic import BaseModel, Field


class PushDeviceRegister(BaseModel):
    platform: str = Field(default="android", max_length=40)
    token: str = Field(min_length=20)
    device_id: str | None = Field(default=None, max_length=160)


class PushDeviceRead(BaseModel):
    id: int
    platform: str
    is_active: bool
    last_seen_at: datetime | None

    model_config = {"from_attributes": True}
