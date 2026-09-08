from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field, ValidationInfo


def _display_note_title(value: str, info: ValidationInfo) -> str:
    number = info.data.get("number")
    return f"Monteurhinweis {number}" if value == f"Notizstand {number}" else value


NoteTitle = Annotated[str, AfterValidator(_display_note_title)]


class SiteNoteBlockRead(BaseModel):
    id: int
    number: int
    title: NoteTitle
    content: str
    visible_to_workers: bool
    revision: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SiteNotesRead(BaseModel):
    internal_notes: str = ""
    internal_revision: int = 0
    blocks: list[SiteNoteBlockRead] = Field(default_factory=list)


class SiteInternalNoteUpdate(BaseModel):
    content: str = Field(max_length=20000)
    expected_revision: int = Field(ge=0)


class SiteNoteBlockUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(max_length=20000)
    visible_to_workers: bool
    expected_revision: int = Field(ge=1)


class MobileSiteNote(BaseModel):
    id: int
    number: int
    title: NoteTitle
    content: str
    updated_at: datetime

    model_config = {"from_attributes": True}


class MobileProjectNotes(BaseModel):
    info: str | None = None
    note_blocks: list[MobileSiteNote] = Field(default_factory=list)
