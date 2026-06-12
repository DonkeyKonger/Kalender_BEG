from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class SiteEmailRecipientPayload(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    label: str | None = Field(default=None, max_length=200)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if "@" not in cleaned or "." not in cleaned.rsplit("@", 1)[-1]:
            raise ValueError("E-Mail-Adresse ist nicht gueltig.")
        return cleaned

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None


class SiteEmailRecipientsUpdate(BaseModel):
    recipients: list[SiteEmailRecipientPayload] = Field(default_factory=list, max_length=50)


class SiteEmailRecipientRead(BaseModel):
    id: int | None = None
    email: str
    label: str | None = None
    source: str | None = None
    is_selected: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SiteEmailRecipientsResponse(BaseModel):
    site_id: int
    recipients: list[SiteEmailRecipientRead] = Field(default_factory=list)
    suggestions: list[SiteEmailRecipientRead] = Field(default_factory=list)
