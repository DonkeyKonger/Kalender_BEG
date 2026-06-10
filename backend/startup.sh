#!/usr/bin/env bash
set -euo pipefail

alembic upgrade head

RUN_SEED_VALUE="${RUN_SEED_DATA:-${RUN_SEED:-false}}"
case "${RUN_SEED_VALUE,,}" in
  true|1|yes)
    python -m app.seed_data
    ;;
  *)
    echo "Seed-Daten übersprungen: RUN_SEED_DATA/RUN_SEED ist nicht aktiviert."
    ;;
esac

exec gunicorn -w 2 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000 app.main:app
