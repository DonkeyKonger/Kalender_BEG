#!/usr/bin/env bash
set -euo pipefail

alembic upgrade head
python -m app.seed_data || true
exec gunicorn -w 2 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000 app.main:app
