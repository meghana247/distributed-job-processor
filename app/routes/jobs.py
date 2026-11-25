import hashlib
import json
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db, utcnow
from app.models import TERMINAL, Job, JobAttempt, JobStatus, User
from app.schemas import JobCreate, JobDetail, JobOut, Page, Stats
from app.security import current_user
from app.tasks import run_job

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _fingerprint(body: JobCreate) -> str:
    return hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()


def _owned(db: Session, job_id: uuid.UUID, user: User) -> Job:
    job = db.get(Job, job_id)
    # 404 rather than 403 so job ids belonging to other users are not confirmed to exist.
    if job is None or job.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    return job


def _replay(existing: Job, fingerprint: str, response: Response) -> Job:
    if existing.payload_hash != fingerprint:
        raise HTTPException(status.HTTP_409_CONFLICT, "Idempotency-Key was already used with a different request")
    response.status_code = status.HTTP_200_OK
    response.headers["Idempotent-Replayed"] = "true"
    return existing


@router.post("", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
def create_job(
    body: JobCreate,
    response: Response,
    idempotency_key: str | None = Header(default=None, max_length=255),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Job:
    """Queue a job. Resending with the same Idempotency-Key returns the original job instead of a duplicate."""
    fingerprint = _fingerprint(body)
    if idempotency_key:
        existing = db.scalar(select(Job).where(Job.user_id == user.id, Job.idempotency_key == idempotency_key))
        if existing:
            return _replay(existing, fingerprint, response)

    job = Job(
        user_id=user.id,
        type=body.type,
        payload=body.payload,
        max_retries=body.max_retries,
        payload_hash=fingerprint,
        idempotency_key=idempotency_key,
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request with the same key inserted first; the unique constraint caught it.
        db.rollback()
        existing = db.scalar(select(Job).where(Job.user_id == user.id, Job.idempotency_key == idempotency_key))
        return _replay(existing, fingerprint, response)

    run_job.delay(str(job.id))
    db.refresh(job)
    return job


@router.get("", response_model=Page[JobOut])
def list_jobs(
    status_: JobStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, le=200),
    offset: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Page[JobOut]:
    query = select(Job).where(Job.user_id == user.id)
    if status_:
        query = query.where(Job.status == status_)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    jobs = db.scalars(query.order_by(Job.created_at.desc()).limit(limit).offset(offset)).all()
    return Page(items=[JobOut.model_validate(j) for j in jobs], total=total)


@router.get("/stats", response_model=Stats)
def stats(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Stats:
    by_status = dict(
        db.execute(select(Job.status, func.count()).where(Job.user_id == user.id).group_by(Job.status)).all()
    )
    done = by_status.get(JobStatus.SUCCEEDED, 0) + by_status.get(JobStatus.FAILED, 0)
    mine = select(Job.id).where(Job.user_id == user.id)
    avg = db.scalar(
        select(func.avg(JobAttempt.duration_ms)).where(JobAttempt.job_id.in_(mine), JobAttempt.status == "succeeded")
    )
    retried = db.scalar(select(func.count()).where(JobAttempt.job_id.in_(mine), JobAttempt.number > 1)) or 0

    now = utcnow()
    window = now - timedelta(minutes=30)
    finished = db.scalars(select(Job.finished_at).where(Job.user_id == user.id, Job.finished_at >= window)).all()
    throughput = [0] * 30
    for ts in finished:
        if ts.tzinfo is None:  # SQLite drops tzinfo
            ts = ts.replace(tzinfo=now.tzinfo)
        throughput[min(29, int((ts - window).total_seconds() // 60))] += 1

    return Stats(
        by_status=by_status,
        total=sum(by_status.values()),
        success_rate=by_status.get(JobStatus.SUCCEEDED, 0) / done if done else None,
        retried_attempts=retried,
        avg_duration_ms=float(avg) if avg is not None else None,
        throughput=throughput,
    )


@router.get("/templates")
def templates() -> list[dict]:
    """Ready-made demo jobs. The flaky endpoint is served by this API under /mock."""
    base = settings.mock_base_url
    return [
        {
            "name": "Flaky API call",
            "description": "Third-party API that fails 60% of the time with 503/429. Watch retries back off.",
            "type": "http_request",
            "payload": {"url": f"{base}/mock/flaky?fail_rate=0.6"},
            "max_retries": 5,
        },
        {
            "name": "Healthy API call",
            "description": "Succeeds on the first attempt.",
            "type": "http_request",
            "payload": {"url": f"{base}/mock/flaky?fail_rate=0"},
            "max_retries": 3,
        },
        {
            "name": "Generate report",
            "description": "Long-running job that reports progress as it goes.",
            "type": "generate_report",
            "payload": {"rows": 50000, "seconds": 8},
            "max_retries": 2,
        },
        {
            "name": "Send email",
            "description": "Quick job with input validation.",
            "type": "send_email",
            "payload": {"to": "customer@example.com", "subject": "Your invoice"},
            "max_retries": 3,
        },
        {
            "name": "Permanent failure",
            "description": "API returns 404. Not retryable, so it fails immediately.",
            "type": "http_request",
            "payload": {"url": f"{base}/mock/status/404"},
            "max_retries": 5,
        },
    ]


@router.get("/{job_id}", response_model=JobDetail)
def get_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Job:
    return _owned(db, job_id, user)


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Job:
    job = _owned(db, job_id, user)
    if job.status in TERMINAL:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Job is already {job.status}")
    # A running job finishes its current attempt, but the worker's conditional write discards the result.
    job.status, job.finished_at, job.next_retry_at = JobStatus.CANCELLED, utcnow(), None
    db.commit()
    return job


@router.post("/{job_id}/retry", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED)
def retry_job(job_id: uuid.UUID, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Job:
    """Re-drive a failed or cancelled job with a fresh retry budget (dead-letter replay)."""
    job = _owned(db, job_id, user)
    if job.status not in (JobStatus.FAILED, JobStatus.CANCELLED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Only failed or cancelled jobs can be retried")
    job.status, job.attempts, job.progress = JobStatus.QUEUED, 0, 0
    job.error = job.finished_at = job.result = None
    db.commit()
    run_job.delay(str(job.id))
    db.refresh(job)
    return job
