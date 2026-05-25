from pydantic import BaseModel, Field


class MicrosoftGraphResource(BaseModel):
    id: str | None = None
    name: str | None = None
    web_url: str | None = None


class MicrosoftGraphConnectionTestResponse(BaseModel):
    connected: bool
    graph_enabled: bool
    reason: str | None = None
    status_code: int | None = None
    missing_config: list[str] = Field(default_factory=list)
    drive: MicrosoftGraphResource | None = None
    root_folder: MicrosoftGraphResource | None = None
    site: MicrosoftGraphResource | None = None


class MicrosoftGraphCreatedSubfolder(BaseModel):
    sort_order: int
    name: str
    id: str | None = None
    web_url: str | None = None


class MicrosoftGraphCreateTestFolderResponse(BaseModel):
    created: bool
    root_folder: MicrosoftGraphResource
    subfolders: list[MicrosoftGraphCreatedSubfolder]
