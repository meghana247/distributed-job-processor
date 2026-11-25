from datetime import timedelta

import pytest
from sqlalchemy import update

from app import handlers
from app.db import SessionLocal, utcnow
from app.handlers import PermanentError, RetryableError
from app.models import Job, JobStatus
from app.tasks import backoff_seconds, reap_stale_jobs

from .conftest import signup


@pytest.fixture
def fake_handler(monkeypatch):
    """Register a handler that fails `failures` times (retryable unless permanent) and then succeeds."""
    calls = {"n": 0}

    def install(failures: int = 0, permanent: bool = False):
        def run(payload, progress):
            calls["n"] += 1
            if calls["n"] <= failures:
                raise (PermanentError if permanent else RetryableError)(f"boom {calls['n']}")
            progress(100)
            return {"ok": True}

        monkeypatch.setitem(handlers.HANDLERS, "send_email", run)
        return calls

    return install


def submit(client, auth, key=None, **body):
    headers = {**auth, **({"Idempotency-Key": key} if key else {})}
    return client.post("/jobs", json={"type": "send_email", "payload": {"to": "x@y.z"}, **body}, headers=headers)


def test_requires_auth(client):
    assert client.get("/jobs").status_code == 401
    assert client.get("/jobs", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_job_runs_to_success(client, auth, fake_handler):
    fake_handler()
    job = submit(client, auth).json()
    detail = client.get(f"/jobs/{job['id']}", headers=auth).json()
    assert detail["status"] == "succeeded"
    assert detail["result"] == {"ok": True}
    assert [a["status"] for a in detail["attempt_log"]] == ["succeeded"]


def test_transient_failures_are_retried(client, auth, fake_handler):
    calls = fake_handler(failures=2)
    job = submit(client, auth, max_retries=3).json()
    detail = client.get(f"/jobs/{job['id']}", headers=auth).json()
    assert detail["status"] == "succeeded"
    assert calls["n"] == 3
    assert [a["status"] for a in detail["attempt_log"]] == ["failed", "failed", "succeeded"]


def test_retries_are_bounded(client, auth, fake_handler):
    calls = fake_handler(failures=99)
    job = submit(client, auth, max_retries=2).json()
    detail = client.get(f"/jobs/{job['id']}", headers=auth).json()
    assert detail["status"] == "failed"
    assert calls["n"] == 3  # first attempt + 2 retries


def test_permanent_failure_is_not_retried(client, auth, fake_handler):
    calls = fake_handler(failures=1, permanent=True)
    job = submit(client, auth, max_retries=5).json()
    assert client.get(f"/jobs/{job['id']}", headers=auth).json()["status"] == "failed"
    assert calls["n"] == 1


def test_idempotency_key_returns_original_job(client, auth, fake_handler):
    calls = fake_handler()
    first = submit(client, auth, key="order-42")
    second = submit(client, auth, key="order-42")
    assert first.status_code == 202
    assert second.status_code == 200
    assert second.headers["Idempotent-Replayed"] == "true"
    assert first.json()["id"] == second.json()["id"]
    assert calls["n"] == 1


def test_idempotency_key_reused_with_different_body_conflicts(client, auth, fake_handler):
    fake_handler()
    submit(client, auth, key="k1")
    assert submit(client, auth, key="k1", max_retries=7).status_code == 409


def test_idempotency_keys_are_per_user(client, auth, fake_handler):
    fake_handler()
    other = signup(client, "b@example.com")
    assert submit(client, auth, key="same").json()["id"] != submit(client, other, key="same").json()["id"]


def test_users_cannot_see_each_others_jobs(client, auth, fake_handler):
    fake_handler()
    job = submit(client, auth).json()
    other = signup(client, "b@example.com")
    assert client.get(f"/jobs/{job['id']}", headers=other).status_code == 404
    assert client.get("/jobs", headers=other).json()["total"] == 0


def test_failed_job_can_be_redriven(client, auth, fake_handler):
    fake_handler(failures=1, permanent=True)
    job = submit(client, auth, max_retries=0).json()
    redriven = client.post(f"/jobs/{job['id']}/retry", headers=auth)
    assert redriven.status_code == 202
    detail = client.get(f"/jobs/{job['id']}", headers=auth).json()
    assert detail["status"] == "succeeded"
    assert [a["number"] for a in detail["attempt_log"]] == [1, 2]


def test_finished_job_cannot_be_cancelled(client, auth, fake_handler):
    fake_handler()
    job = submit(client, auth).json()
    assert client.post(f"/jobs/{job['id']}/cancel", headers=auth).status_code == 409


def test_reaper_recovers_job_from_dead_worker(client, auth, fake_handler):
    calls = fake_handler()
    job = submit(client, auth).json()
    # Simulate a worker that claimed the job and then died: running, heartbeat long gone.
    with SessionLocal() as db:
        db.execute(
            update(Job).values(status=JobStatus.RUNNING, attempts=1, heartbeat_at=utcnow() - timedelta(minutes=10))
        )
        db.commit()
    assert reap_stale_jobs() == 1
    assert client.get(f"/jobs/{job['id']}", headers=auth).json()["status"] == "succeeded"
    assert calls["n"] == 2


def test_redelivered_message_does_not_run_job_twice(client, auth, fake_handler):
    from app.tasks import run_job

    calls = fake_handler()
    job = submit(client, auth).json()
    run_job(job["id"])  # duplicate delivery of an already-finished job
    assert calls["n"] == 1


def test_backoff_grows_and_honours_retry_after(monkeypatch):
    monkeypatch.setattr("app.tasks.settings.retry_base_seconds", 2.0)
    monkeypatch.setattr("app.tasks.settings.retry_max_seconds", 60.0)
    assert 1 <= backoff_seconds(1) <= 2
    assert 8 <= backoff_seconds(4) <= 16
    assert backoff_seconds(10) <= 60
    assert backoff_seconds(1, retry_after=30) == 30


def test_stats(client, auth, fake_handler):
    fake_handler(failures=1)
    submit(client, auth)
    stats = client.get("/jobs/stats", headers=auth).json()
    assert stats["by_status"] == {"succeeded": 1}
    assert stats["success_rate"] == 1.0
    assert stats["retried_attempts"] == 1
    assert sum(stats["throughput"]) == 1
