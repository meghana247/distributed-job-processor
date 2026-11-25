import logging
import random
import uuid
from datetime import timedelta

from celery import current_task
from sqlalchemy import func, select, update

from app.celery_app import celery
from app.config import settings
from app.db import SessionLocal, utcnow
from app.handlers import HANDLERS, PermanentError
from app.models import Job, JobAttempt, JobStatus

log = logging.getLogger(__name__)


def backoff_seconds(attempt: int, retry_after: float | None = None) -> float:
    """Exponential backoff with jitter, never sooner than the server's Retry-After.

    Half the delay is fixed and half random, so many jobs failing against the same
    recovering service do not all retry in the same instant.
    """
    ceiling = min(settings.retry_max_seconds, settings.retry_base_seconds * 2 ** (attempt - 1))
    delay = ceiling / 2 + random.uniform(0, ceiling / 2)
    return max(delay, retry_after or 0)


@celery.task(name="jobs.run")
def run_job(job_id: str) -> None:
    jid = uuid.UUID(job_id)
    with SessionLocal() as db:
        now = utcnow()
        # Atomic claim: only a job that is waiting can move to running. A redelivered or
        # duplicated message for a job already running, finished or cancelled changes no row.
        attempts = db.execute(
            update(Job)
            .where(Job.id == jid, Job.status.in_([JobStatus.QUEUED, JobStatus.RETRYING]))
            .values(
                status=JobStatus.RUNNING,
                attempts=Job.attempts + 1,
                heartbeat_at=now,
                next_retry_at=None,
                started_at=func.coalesce(Job.started_at, now),
            )
            .returning(Job.attempts)
        ).scalar_one_or_none()
        if attempts is None:
            db.rollback()
            return

        number = (db.scalar(select(func.count()).where(JobAttempt.job_id == jid)) or 0) + 1
        worker = (current_task.request.hostname if current_task else None) or "local"
        attempt = JobAttempt(job_id=jid, number=number, status="running", started_at=now, worker=worker)
        db.add(attempt)
        db.commit()
        job = db.get(Job, jid)
        assert job is not None

        def progress(pct: int) -> None:
            db.execute(update(Job).where(Job.id == jid).values(progress=pct, heartbeat_at=utcnow()))
            db.commit()

        error: Exception | None = None
        result: dict | None = None
        try:
            result = HANDLERS[job.type](job.payload, progress)
        except PermanentError as exc:
            error, retryable = exc, False
        except Exception as exc:  # RetryableError, or an unexpected bug: retry within the budget
            error, retryable = exc, True

        finished = utcnow()
        attempt.finished_at = finished
        attempt.duration_ms = int((finished - now).total_seconds() * 1000)
        # Every final write is conditional on the job still being ours: if it was
        # cancelled while running, the result is discarded rather than overwriting that.
        still_running = (Job.id == jid, Job.status == JobStatus.RUNNING)

        if error is None:
            attempt.status = "succeeded"
            db.execute(
                update(Job)
                .where(*still_running)
                .values(status=JobStatus.SUCCEEDED, result=result, progress=100, error=None, finished_at=finished)
            )
            db.commit()
            return

        attempt.status, attempt.error, attempt.retryable = "failed", str(error), retryable
        if retryable and attempts <= job.max_retries:
            delay = backoff_seconds(attempts, getattr(error, "retry_after", None))
            moved = db.execute(
                update(Job)
                .where(*still_running)
                .values(status=JobStatus.RETRYING, error=str(error), next_retry_at=finished + timedelta(seconds=delay))
            ).rowcount
            db.commit()
            if moved:
                log.info("job %s attempt %s failed, retrying in %.1fs: %s", jid, attempts, delay, error)
                run_job.apply_async((job_id,), countdown=delay)
            return

        # Out of retries, or not worth retrying: the job is dead-lettered as failed.
        db.execute(
            update(Job).where(*still_running).values(status=JobStatus.FAILED, error=str(error), finished_at=finished)
        )
        db.commit()


@celery.task(name="jobs.reap")
def reap_stale_jobs() -> int:
    """Recover jobs whose worker died or whose queue message was lost.

    Safe to run often and on several schedulers: re-enqueueing is idempotent because
    run_job's atomic claim ignores any job that is not waiting.
    """
    now = utcnow()
    cutoff = now - timedelta(seconds=settings.lease_seconds)
    with SessionLocal() as db:
        stale = db.scalars(
            select(Job)
            .where(Job.status == JobStatus.RUNNING, Job.heartbeat_at < cutoff)
            .with_for_update(skip_locked=True)
        ).all()
        for job in stale:
            open_attempt = next((a for a in reversed(job.attempt_log) if a.status == "running"), None)
            if open_attempt:
                open_attempt.status, open_attempt.error, open_attempt.retryable = (
                    "failed",
                    "Worker lost (lease expired)",
                    True,
                )
                open_attempt.finished_at = now
            if job.attempts <= job.max_retries:
                job.status = JobStatus.QUEUED
            else:
                job.status, job.error, job.finished_at = JobStatus.FAILED, "Worker lost and retries exhausted", now

        # Waiting jobs whose message never arrived (broker restart, enqueue failure).
        orphaned = db.scalars(
            select(Job.id).where(
                (Job.status == JobStatus.QUEUED) & (Job.created_at < cutoff)
                | (Job.status == JobStatus.RETRYING) & (Job.next_retry_at < cutoff)
            )
        ).all()
        db.commit()

    requeue = {j.id for j in stale if j.status == JobStatus.QUEUED} | set(orphaned)
    for jid in requeue:
        run_job.delay(str(jid))
    if requeue:
        log.warning("reaper requeued %d job(s)", len(requeue))
    return len(requeue)
