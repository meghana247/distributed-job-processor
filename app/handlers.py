"""Job handlers. Each takes the job payload and a progress callback and returns a JSON result.

Handlers signal failure by type: RetryableError for transient problems (timeouts, 429, 5xx),
PermanentError for ones a retry cannot fix (4xx, bad input). The runner decides what happens next.
"""

import time
import uuid
from collections.abc import Callable

import httpx

Progress = Callable[[int], None]
Handler = Callable[[dict, Progress], dict]


class RetryableError(Exception):
    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class PermanentError(Exception):
    pass


HANDLERS: dict[str, Handler] = {}


def handler(name: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        return fn

    return register


@handler("http_request")
def http_request(payload: dict, progress: Progress) -> dict:
    """Call a third-party API, classifying failures the way an integration should."""
    url, method = payload["url"], payload.get("method", "GET").upper()
    try:
        response = httpx.request(method, url, json=payload.get("body"), timeout=payload.get("timeout", 10))
    except httpx.TimeoutException:
        raise RetryableError(f"Timed out calling {url}") from None
    except httpx.TransportError as exc:
        raise RetryableError(f"Connection error calling {url}: {exc}") from None

    if response.status_code == 429 or response.status_code >= 500:
        retry_after = response.headers.get("Retry-After")
        raise RetryableError(
            f"HTTP {response.status_code} from {url}",
            retry_after=float(retry_after) if retry_after and retry_after.isdigit() else None,
        )
    if response.status_code >= 400:
        raise PermanentError(f"HTTP {response.status_code} from {url}: {response.text[:200]}")

    progress(100)
    try:
        body = response.json()
    except ValueError:
        body = response.text[:500]
    return {"status_code": response.status_code, "body": body}


@handler("generate_report")
def generate_report(payload: dict, progress: Progress) -> dict:
    """Long-running work that reports progress (each progress call is also the job's heartbeat)."""
    rows, seconds, steps = int(payload.get("rows", 10_000)), float(payload.get("seconds", 8)), 10
    for step in range(1, steps + 1):
        time.sleep(seconds / steps)
        progress(step * 100 // steps)
    return {"rows_processed": rows, "file": f"report-{uuid.uuid4().hex[:8]}.csv"}


@handler("send_email")
def send_email(payload: dict, progress: Progress) -> dict:
    to = str(payload.get("to", ""))
    if "@" not in to:
        raise PermanentError(f"Invalid recipient address: {to!r}")
    time.sleep(0.5)
    progress(100)
    return {"delivered_to": to, "message_id": f"<{uuid.uuid4().hex}@jobs.local>"}
