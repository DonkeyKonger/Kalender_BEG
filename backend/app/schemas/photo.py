from pydantic import BaseModel, Field, field_validator


class PhotoCaptionUpdate(BaseModel):
    caption: str | None = Field(default=None, max_length=500)

    @field_validator("caption")
    @classmethod
    def normalize_caption(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None
