import os

# Must be set before the app is imported: settings, the engine and Celery read them at import time.
os.environ.update(
    DATABASE_URL="sqlite:///./test.db", CELERY_EAGER="true", RETRY_BASE_SECONDS="0", RETRY_MAX_SECONDS="0"
)

import pytest
from fastapi.testclient import TestClient

from app.db import Base, engine
from app.main import app


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def signup(client: TestClient, email: str = "a@example.com") -> dict:
    client.post("/auth/register", json={"email": email, "password": "password123"})
    token = client.post("/auth/login", json={"email": email, "password": "password123"}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth(client: TestClient) -> dict:
    return signup(client)
