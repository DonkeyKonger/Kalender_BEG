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

if python -m app.scripts.import_bundled_tools; then
  echo "Werkzeugimport beim Start abgeschlossen."
else
  import_status=$?
  echo "WARNUNG: Werkzeugimport beim Start fehlgeschlagen (Exit ${import_status})." >&2
  echo "Die API wird trotzdem gestartet; Details sind über /api/health/tool-import prüfbar." >&2
fi

exec gunicorn -w 2 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000 app.main:app
