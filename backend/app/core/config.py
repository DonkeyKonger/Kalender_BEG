from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(alias="DATABASE_URL")
    secret_key: str = Field(alias="SECRET_KEY")
    environment: str = Field(default="local", alias="ENVIRONMENT")
    access_token_expire_minutes: int = Field(default=43200, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    access_token_refresh_grace_minutes: int = Field(
        default=0, alias="ACCESS_TOKEN_REFRESH_GRACE_MINUTES"
    )
    admin_username: str | None = Field(default=None, alias="ADMIN_USERNAME")
    admin_password: str | None = Field(default=None, alias="ADMIN_PASSWORD")
    admin_display_name: str = Field(default="Administrator", alias="ADMIN_DISPLAY_NAME")
    seed_default_password: str | None = Field(default=None, alias="SEED_DEFAULT_PASSWORD")
    run_seed_data: bool = Field(
        default=False,
        validation_alias=AliasChoices("RUN_SEED_DATA", "RUN_SEED"),
    )
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")
    company_location_label: str = Field(default="Firmenzentrale Achim", alias="COMPANY_LOCATION_LABEL")
    company_location_lat: float = Field(default=53.0142, alias="COMPANY_LOCATION_LAT")
    company_location_lon: float = Field(default=9.0263, alias="COMPANY_LOCATION_LON")
    weather_cache_ttl_minutes: int = Field(default=45, alias="WEATHER_CACHE_TTL_MINUTES")
    weather_request_timeout_seconds: float = Field(default=5.0, alias="WEATHER_REQUEST_TIMEOUT_SECONDS")
    ms_graph_enabled: bool = Field(default=False, alias="MS_GRAPH_ENABLED")
    ms_graph_create_test_folders_enabled: bool = Field(
        default=False, alias="MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED"
    )
    ms_graph_create_project_folders_enabled: bool = Field(
        default=False, alias="MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED"
    )
    ms_tenant_id: str | None = Field(default=None, alias="MS_TENANT_ID")
    ms_client_id: str | None = Field(default=None, alias="MS_CLIENT_ID")
    ms_client_secret: str | None = Field(default=None, alias="MS_CLIENT_SECRET")
    ms_project_site_id: str | None = Field(default=None, alias="MS_PROJECT_SITE_ID")
    ms_project_drive_id: str | None = Field(default=None, alias="MS_PROJECT_DRIVE_ID")
    ms_project_root_folder_id: str | None = Field(default=None, alias="MS_PROJECT_ROOT_FOLDER_ID")
    ms_graph_timeout_seconds: float = Field(default=15.0, alias="MS_GRAPH_TIMEOUT_SECONDS")
    ms_graph_base_url: str = Field(
        default="https://graph.microsoft.com/v1.0", alias="MS_GRAPH_BASE_URL"
    )
    document_thumbnail_cache_dir: str = Field(
        default="/tmp/kalender_beg_document_thumbnails",
        alias="DOCUMENT_THUMBNAIL_CACHE_DIR",
    )
    document_pdf_cache_dir: str = Field(
        default="/tmp/kalender_beg_document_pdfs",
        alias="DOCUMENT_PDF_CACHE_DIR",
    )
    ctrack_base_url: str | None = Field(default=None, alias="CTRACK_BASE_URL")
    ctrack_username: str | None = Field(default=None, alias="CTRACK_USERNAME")
    ctrack_password: str | None = Field(default=None, alias="CTRACK_PASSWORD")
    smtp_host: str | None = Field(default=None, alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_username: str | None = Field(default=None, alias="SMTP_USERNAME")
    smtp_password: str | None = Field(default=None, alias="SMTP_PASSWORD")
    smtp_from_email: str | None = Field(default=None, alias="SMTP_FROM_EMAIL")
    smtp_from_name: str = Field(default="BEG Baustellenkalender", alias="SMTP_FROM_NAME")
    smtp_use_starttls: bool = Field(default=True, alias="SMTP_USE_STARTTLS")

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
