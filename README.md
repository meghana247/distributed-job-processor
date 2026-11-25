# Distributed Job Processor

An asynchronous job-processing API. Clients submit work over HTTP and get a `202`
straight away; Celery workers run it in the background. Failures are handled the way
a production integration needs: transient errors retry with exponential backoff,
permanent ones fail fast, duplicate submissions are collapsed with idempotency keys,
and jobs from a crashed worker are recovered automatically.

**Stack:** Python · FastAPI · Celery · Redis · PostgreSQL · SQLAlchemy 2 · JWT · React + TypeScript + Tailwind · Docker

```
 React console ──► FastAPI ──► PostgreSQL  (source of truth: jobs, attempts)
                     │             ▲
                     ▼             │
                   Redis ──► Celery workers ×N ──► third-party APIs
                     ▲
                Celery beat (reaper, every 15s)
```

## Running it

```bash
docker compose up --build -d --scale worker=2
```

- Console: http://localhost:3001
- API docs: http://localhost:8001/docs

## How failures are handled

| Situation | What happens |
|---|---|
| **Timeout, connection error, `429`, `5xx`** | `RetryableError`. Retried after `base · 2^(n-1)` seconds (capped) with jitter, and never sooner than the server's `Retry-After`. |
| **`4xx`, invalid input** | `PermanentError`. A retry cannot fix it, so the job fails immediately instead of wasting attempts. |
| **Retries exhausted** | Job is marked `failed` (dead-lettered) with the last error. `POST /jobs/{id}/retry` re-drives it with a fresh budget. |
| **Same request sent twice** | `Idempotency-Key` header: the second call returns the original job with `200` and `Idempotent-Replayed: true`. The same key with a different body is a `409`. A unique constraint on `(user_id, idempotency_key)` makes this safe under concurrent requests too. |
| **Worker crashes mid-job** | Workers write a heartbeat as they make progress. The reaper (Celery beat) finds `running` jobs whose heartbeat is older than the lease, closes the attempt as "worker lost", and re-queues the job. |
| **Message delivered twice** | Workers claim a job with one conditional `UPDATE … WHERE status IN ('queued','retrying') RETURNING`. Only one claim can succeed, so a duplicate message is a no-op. This also makes the reaper safe to re-enqueue anything. |
| **Cancelled while running** | Every final write is conditional on the job still being `running`, so a cancelled job's late result is discarded. |

Celery runs with `acks_late`, `reject_on_worker_lost` and `prefetch_multiplier=1`: a
message is acknowledged only after the job finishes, and a slow job cannot hold
queued messages hostage.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/auth/register`, `/auth/login` | JWT bearer tokens |
| `POST` | `/jobs` | Queue a job. Optional `Idempotency-Key` header |
| `GET` | `/jobs?status=` | List your jobs |
| `GET` | `/jobs/{id}` | Job with its full attempt history |
| `POST` | `/jobs/{id}/cancel` · `/jobs/{id}/retry` | Cancel, or re-drive a failed job |
| `GET` | `/jobs/stats` | Counts, success rate, retries, throughput per minute |
| `GET` | `/mock/flaky?fail_rate=0.6` | A deliberately unreliable "third-party API" for demos |

Job types: `http_request` (call an external API), `generate_report` (long-running, reports
progress), `send_email`. A new type is one function registered with `@handler("name")`.

## Demo script

1. **Flaky API call → Submit.** Open the job: the attempt timeline shows `503`/`429`
   failures marked *retryable*, growing delays, and finally success.
2. **Resend same key.** The toast says the job was replayed. No duplicate appears.
3. **Permanent failure.** Fails on attempt 1 of 6: a `404` is not worth retrying.
4. **Burst × 20.** Watch throughput, and see the attempt log show jobs spread across workers.
5. **Kill a worker mid-job:** submit *Generate report*, then `docker kill` the worker running
   it. About a minute later the attempt is closed as "Worker lost (lease expired)" and the job
   completes on another worker.

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q
```

Covers retries and their bounds, permanent failures, idempotency (replay, conflict, per-user
scope), user isolation, re-drive, duplicate delivery, worker-loss recovery, backoff maths and
stats. Tests use SQLite and run Celery tasks inline.
