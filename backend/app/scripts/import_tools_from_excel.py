from __future__ import annotations

import argparse
from collections.abc import Callable
import json
from pathlib import Path
import sys

from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.services.tool_material_excel_import import (
    ImportReport,
    ToolMaterialExcelImporter,
    create_backup,
    read_source_rows,
    verify_applied_import,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sicherer Einmalimport des Tabellenblatts Maschinen."
    )
    parser.add_argument("--file", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.apply and args.backup_dir is None:
        parser.error("--apply erfordert ein explizites --backup-dir.")
    return args


def execute_import(
    source_file: Path,
    *,
    apply: bool,
    backup_dir: Path | None = None,
    report_file: Path | None = None,
    session_factory: Callable[[], Session] = SessionLocal,
) -> tuple[int, ImportReport]:
    source_file = source_file.expanduser().resolve()
    mode = "apply" if apply else "dry-run"
    try:
        rows, report = read_source_rows(source_file)
    except Exception as error:
        report = ImportReport(mode=mode, file=str(source_file), errors=[str(error)])
        _write_report(report, report_file)
        return 2, report
    report.mode = mode
    if report.blockers:
        _write_report(report, report_file)
        return 2, report

    db = session_factory()
    try:
        importer = ToolMaterialExcelImporter(db, rows, report)
        plans = importer.plan()
        if apply:
            if report.blockers:
                db.rollback()
            elif report.creates == 0 and report.updates == 0:
                db.rollback()
                report.applied = True
                report.already_applied = True
            else:
                if backup_dir is None:
                    raise ValueError("Ein Apply-Import benötigt ein Backup-Verzeichnis.")
                backup = create_backup(db, backup_dir.expanduser().resolve())
                report.backup_file = str(backup)
                importer.apply(plans)
                verify_applied_import(db, rows, report)
                db.commit()
                report.applied = True
        else:
            db.rollback()
    except Exception as error:
        db.rollback()
        report.errors.append(str(error))
    finally:
        db.close()

    _write_report(report, report_file)
    return (0 if not report.blockers else 2), report


def _write_report(report: ImportReport, report_file: Path | None) -> None:
    output = json.dumps(report.to_dict(), ensure_ascii=False, indent=2, sort_keys=True)
    if report_file:
        report_file = report_file.expanduser().resolve()
        report_file.parent.mkdir(parents=True, exist_ok=True)
        report_file.write_text(output + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    status, report = execute_import(
        args.file,
        apply=args.apply,
        backup_dir=args.backup_dir,
        report_file=args.report,
    )
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
    return status


if __name__ == "__main__":
    sys.exit(main())
