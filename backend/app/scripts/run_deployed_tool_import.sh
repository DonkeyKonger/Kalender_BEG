#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/home/site/wwwroot}"
PYTHON_BIN="${PYTHON_BIN:-python}"
SOURCE_FILE="${TOOL_IMPORT_FILE:-${PROJECT_ROOT}/app/import_data/BEG-Maschinen+Werkzeugliste.xlsx}"
DATA_ROOT="${TOOL_IMPORT_DATA_ROOT:-/home/data/tool-material-import}"
EXPECTED_SHA256="347473065a64fc45a877eee03dd5cf5cb619d0a0adaa4ed8ad3b8aec7bf56d46"
IMPORT_VERSION="${EXPECTED_SHA256:0:16}"
REPORT_DIR="${DATA_ROOT}/reports/${IMPORT_VERSION}"
BACKUP_DIR="${DATA_ROOT}/backups"
DRY_RUN_REPORT="${REPORT_DIR}/dry-run.json"
APPLY_REPORT="${REPORT_DIR}/apply.json"

mkdir -p "${REPORT_DIR}" "${BACKUP_DIR}"

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Werkzeugimport abgebrochen: Importdatei fehlt unter ${SOURCE_FILE}." >&2
  exit 10
fi

ACTUAL_SHA256="$(sha256sum "${SOURCE_FILE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "Werkzeugimport abgebrochen: Prüfsumme der Importdatei stimmt nicht." >&2
  exit 11
fi

cd "${PROJECT_ROOT}"

# The health check in the deployment workflow ensures startup migrations are finished.
# Running this once more is harmless and protects manual workflow executions.
"${PYTHON_BIN}" -m alembic upgrade head

if ! "${PYTHON_BIN}" -m app.scripts.import_tools_from_excel \
  --file "${SOURCE_FILE}" \
  --dry-run \
  --report "${DRY_RUN_REPORT}" \
  > "${REPORT_DIR}/dry-run-console.json"; then
  echo "Werkzeugimport abgebrochen: Dry-Run ist nicht freigegeben. Bericht: ${DRY_RUN_REPORT}" >&2
  exit 12
fi

if ! "${PYTHON_BIN}" -m app.scripts.import_tools_from_excel \
  --file "${SOURCE_FILE}" \
  --apply \
  --backup-dir "${BACKUP_DIR}" \
  --report "${APPLY_REPORT}" \
  > "${REPORT_DIR}/apply-console.json"; then
  echo "Werkzeugimport fehlgeschlagen; die Datenbanktransaktion wurde zurückgerollt. Bericht: ${APPLY_REPORT}" >&2
  exit 13
fi

"${PYTHON_BIN}" - "${APPLY_REPORT}" <<'PY'
import json
from pathlib import Path
import sys

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not report.get("applied") or report.get("blockers"):
    raise SystemExit("Apply-Bericht bestätigt keinen erfolgreichen Import.")
print(
    "Werkzeugimport erfolgreich: "
    f"{report['physical_tool_rows']} zugeordnet, "
    f"{report['creates']} neu, {report['updates']} aktualisiert, "
    f"{report['unchanged']} unverändert."
)
PY
