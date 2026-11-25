"""A deliberately unreliable 'third-party API' for demonstrating retry behaviour."""

import random

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/mock", tags=["mock third-party API"])


@router.get("/flaky")
def flaky(fail_rate: float = Query(default=0.5, ge=0, le=1)) -> JSONResponse:
    if random.random() < fail_rate:
        if random.random() < 0.3:
            return JSONResponse({"error": "rate limited"}, status_code=429, headers={"Retry-After": "3"})
        return JSONResponse({"error": "service unavailable"}, status_code=503)
    return JSONResponse({"ok": True, "records_synced": random.randint(10, 500)})


@router.get("/status/{code}")
def fixed_status(code: int) -> JSONResponse:
    return JSONResponse({"status": code}, status_code=code)
