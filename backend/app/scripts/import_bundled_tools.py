from __future__ import annotations

import argparse
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


SOURCE_RELATIVE_PATH = Path("app/import_data/BEG-Maschinen+Werkzeugliste.xlsx")
EXPECTED_SHA256 = "347473065a64fc45a877eee03dd5cf5cb619d0a0adaa4ed8ad3b8aec7bf56d46"


def resolve_app_root(anchor: Path | None = None) -> Path:
    if anchor is not None:
        return anchor.expanduser().resolve()
    return Path(__file__).resolve().parents[2]


def resolve_bundled_source(app_root: Path | None = None) -> Path:
    root = resolve_app_root(app_root)
    source_file = (root / SOURCE_RELATIVE_PATH).resolve()
    if not source_file.is_file():
        raise FileNotFoundError(_missing_source_message(root, source_file))
    actual_sha256 = hashlib.sha256(source_file.read_bytes()).hexdigest()
    if actual_sha256 != EXPECTED_SHA256:
        raise ValueError(
            "Werkzeug-Importdatei besitzt eine unerwartete Prüfsumme. "
            f"Pfad: {source_file}; erwartet: {EXPECTED_SHA256}; "
            f"gefunden: {actual_sha256}."
        )
    return source_file


def _missing_source_message(app_root: Path, source_file: Path) -> str:
    existing_parent = source_file.parent
    while not existing_parent.exists() and existing_parent != existing_parent.parent:
        existing_parent = existing_parent.parent
    try:
        entries = sorted(
            f"{entry.name}/" if entry.is_dir() else entry.name
            for entry in existing_parent.iterdir()
        )
    except OSError as error:
        entries = [f"<Verzeichnis konnte nicht gelesen werden: {error}>"]
    return (
        "Werkzeug-Importdatei fehlt. "
        f"Aufgelöster App-Root: {app_root}; "
        f"erwarteter relativer Pfad: {SOURCE_RELATIVE_PATH.as_posix()}; "
        f"aufgelöster Dateipfad: {source_file}; "
        f"nächster vorhandener Ordner: {existing_parent}; "
        f"Ordnerinhalt: {entries}."
    )


def resolve_data_root() -> Path:
    configured = os.environ.get("TOOL_IMPORT_DATA_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    home = os.environ.get("HOME")
    writable_base = Path(home).expanduser() if home else Path(tempfile.gettempdir())
    return (writable_base / "data" / "kalender-beg-tool-import").resolve()


def verify_bundled_source(app_root: Path | None = None) -> dict[str, object]:
    source_file = resolve_bundled_source(app_root)
    from app.services.tool_material_excel_import import read_source_rows

    rows, report = read_source_rows(source_file)
    if report.blockers:
        raise ValueError("; ".join(report.blockers))
    return {
        "app_root": str(resolve_app_root(app_root)),
        "relative_path": SOURCE_RELATIVE_PATH.as_posix(),
        "resolved_path": str(source_file),
        "sha256": EXPECTED_SHA256,
        "physical_tool_rows": len(rows),
    }


@lru_cache(maxsize=1)
def bundled_source_keys() -> frozenset[str]:
    source_file = resolve_bundled_source()
    from app.services.tool_material_excel_import import read_source_rows

    rows, report = read_source_rows(source_file)
    if report.blockers:
        raise ValueError("; ".join(report.blockers))
    return frozenset(row.import_key for row in rows)


def run_bundled_import() -> int:
    source_file = resolve_bundled_source()
    data_root = resolve_data_root()
    report_file = data_root / "reports" / EXPECTED_SHA256[:16] / "startup-import.json"
    backup_dir = data_root / "backups"

    from app.scripts.import_tools_from_excel import execute_import

    status, report = execute_import(
        source_file,
        apply=True,
        backup_dir=backup_dir,
        report_file=report_file,
    )
    if status != 0:
        print(
            "Werkzeugimport fehlgeschlagen. "
            f"Quelle: {source_file}; Bericht: {report_file}; "
            f"Blocker: {report.blockers}",
            file=sys.stderr,
        )
        return status
    if report.already_applied:
        print(
            "Werkzeugimport bereits vollständig angewendet: "
            f"{report.physical_tool_rows} Datensätze unverändert."
        )
    else:
        print(
            "Werkzeugimport erfolgreich: "
            f"{report.physical_tool_rows} zugeordnet, "
            f"{report.creates} neu, {report.updates} aktualisiert."
        )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Importiert den im App-Artefakt enthaltenen Werkzeug-Datenstamm."
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Prüft nur Pfad, Prüfsumme und Quelldaten im Artefakt.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.check_only:
            print(json.dumps(verify_bundled_source(), ensure_ascii=False, sort_keys=True))
            return 0
        return run_bundled_import()
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
