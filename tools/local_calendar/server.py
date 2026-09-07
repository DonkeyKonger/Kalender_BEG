"""Serve the unmodified application behind a same-origin, local-only test shell."""

import json
import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from runtime import validate_environment

validate_environment(os.environ)

from app.core.database import engine  # noqa: E402
from app.main import create_app  # noqa: E402

FRONTEND = Path("/app/frontend")
LOCAL = Path(__file__).parent
app = create_app()

# Applies to the iframe as well: copied URLs cannot silently contact cloud APIs,
# map servers, images or scripts. Real external document services stay disabled.
CSP = (
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; "
    "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; worker-src 'self' blob:; frame-src 'self' blob:; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
)


@app.middleware("http")
async def local_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-BEG-Environment"] = "isolated-local-test"
    return response


@app.get("/__local-test__/health")
def local_health():
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"environment": "isolated-local-test"}


@app.get("/__local-test__/metadata")
def metadata():
    return json.loads(Path("/local-metadata.json").read_text())


@app.get("/__local-test__/")
def test_shell():
    return FileResponse(LOCAL / "index.html")


app.mount("/__local-test__/assets", StaticFiles(directory=LOCAL / "assets"))


@app.get("/{path:path}")
def frontend(path: str):
    if path.startswith(("api/", "__local-test__/")):
        raise HTTPException(404)
    candidate = (FRONTEND / path).resolve()
    if not candidate.is_relative_to(FRONTEND):
        raise HTTPException(404)
    return FileResponse(candidate if candidate.is_file() else FRONTEND / "index.html")
