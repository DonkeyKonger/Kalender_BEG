from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(alias="DATABASE_URL")
    secret_key: str = Field(alias="SECRET_KEY")
    environment: str = Field(default="local", alias="ENVIRONMENT")
    access_token_expire_minutes: int = Field(default=480, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    admin_username: str | None = Field(default=None, alias="ADMIN_USERNAME")
    admin_password: str | None = Field(default=None, alias="ADMIN_PASSWORD")
    admin_display_name: str = Field(default="Administrator", alias="ADMIN_DISPLAY_NAME")
    seed_default_password: str | None = Field(default=None, alias="SEED_DEFAULT_PASSWORD")
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")
    company_location_label: str = Field(default="Firmenzentrale Achim", alias="COMPANY_LOCATION_LABEL")
    company_location_lat: float = Field(default=53.0142, alias="COMPANY_LOCATION_LAT")
    company_location_lon: float = Field(default=9.0263, alias="COMPANY_LOCATION_LON")
    weather_cache_ttl_minutes: int = Field(default=45, alias="WEATHER_CACHE_TTL_MINUTES")
    weather_request_timeout_seconds: float = Field(default=5.0, alias="WEATHER_REQUEST_TIMEOUT_SECONDS")

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
