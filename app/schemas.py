import uuid
from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field

T = TypeVar("T")
JobType = Literal["http_request", "generate_report", "send_email"]


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str


class JobCreate(BaseModel):
    type: JobType
    payload: dict[str, Any] = {}
    max_retries: int = Field(default=3, ge=0, le=10)


class AttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    number: int
    status: str
    error: str | None
    retryable: bool | None
    worker: str
    started_at: datetime
    finished_at: datetime | None
    duration_ms: int | None


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    type: str
    status: str
    payload: dict[str, Any]
    idempotency_key: str | None
    attempts: int
    max_retries: int
    progress: int
    result: dict[str, Any] | None
    error: str | None
    next_retry_at: datetime | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class JobDetail(JobOut):
    attempt_log: list[AttemptOut]


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int


class Stats(BaseModel):
    by_status: dict[str, int]
    total: int
    success_rate: float | None
    retried_attempts: int
    avg_duration_ms: float | None
    throughput: list[int] = Field(description="Jobs finished per minute, oldest first, last 30 minutes")
