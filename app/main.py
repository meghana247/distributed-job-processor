from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.db import Base, engine
from app.routes import auth, jobs, mock


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Small schema, single service: create tables on boot. A larger system would run Alembic as a deploy step.
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title="Distributed Job Processor", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])
for module in (auth, jobs, mock):
    app.include_router(module.router)


@app.get("/health", tags=["health"])
def health() -> dict:
    with engine.connect() as conn:
        conn.execute(text("select 1"))
    return {"status": "ok"}
