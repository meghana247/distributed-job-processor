from celery import Celery

from app.config import settings

celery = Celery("jobs", broker=settings.redis_url, include=["app.tasks"])
celery.conf.update(
    # Job state lives in Postgres, so Celery's result backend is not needed.
    task_ignore_result=True,
    # Ack only after the task finishes: if a worker dies mid-job the broker redelivers the message.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # One message per worker process at a time, so a slow job cannot hoard queued ones.
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    task_always_eager=settings.celery_eager,
    beat_schedule={"reap-stale-jobs": {"task": "jobs.reap", "schedule": settings.reaper_interval_seconds}},
)
