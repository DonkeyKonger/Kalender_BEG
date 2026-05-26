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
    safe_error_code: str | None = None
    failed_step: str | None = None
    missing_config: list[str] = Field(default_factory=list)
    config_loaded: bool = False
    token_request_attempted: bool = False
    token_acquired: bool = False
    token_error_status_code: int | None = None
    drive_check_attempted: bool = False
    drive_check_status: int | None = None
    drive_error_status_code: int | None = None
    root_folder_check_attempted: bool = False
    root_folder_check_status: int | None = None
    root_folder_error_status_code: int | None = None
    site_check_attempted: bool = False
    site_check_status: int | None = None
    site_error_status_code: int | None = None
    token_audience: str | None = None
    authorization_header_present: bool = False
    authorization_header_scheme: str | None = None
    graph_base_url_used: str | None = None
    drive_url_shape: str | None = None
    microsoft_error_code: str | None = None
    microsoft_error_message_short: str | None = None
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
