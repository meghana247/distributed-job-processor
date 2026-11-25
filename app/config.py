from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://jobs:jobs@localhost:5432/jobs"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "dev-only-secret-change-me-in-production-0123456789"
    jwt_ttl_minutes: int = 12 * 60

    # Retry delay for attempt n is base * 2^(n-1), capped, with jitter.
    retry_base_seconds: float = 2.0
    retry_max_seconds: float = 60.0
    # A running job whose heartbeat is older than this is presumed to have lost its worker.
    lease_seconds: int = 60
    reaper_interval_seconds: float = 15.0

    # Where workers reach the built-in flaky endpoint used by the demo templates.
    mock_base_url: str = "http://api:8000"
    cors_origins: list[str] = ["http://localhost:3001", "http://localhost:5173"]

    celery_eager: bool = False  # run tasks inline; used by tests


settings = Settings()
