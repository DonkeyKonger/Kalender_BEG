from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from app.core.database import SessionLocal
from app.services.tool_material_excel_import import (
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


def main() -> int:
    args = parse_args()
    try:
        rows, report = read_source_rows(args.file.expanduser().resolve())
    except Exception as error:
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False, indent=2))
        return 2
    report.mode = "apply" if args.apply else "dry-run"
    db = SessionLocal()
    try:
        importer = ToolMaterialExcelImporter(db, rows, report)
        plans = importer.plan()
        if args.apply:
            if report.blockers:
                db.rollback()
            else:
                backup = create_backup(db, args.backup_dir.expanduser().resolve())
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

    output = json.dumps(report.to_dict(), ensure_ascii=False, indent=2, sort_keys=True)
    print(output)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output + "\n", encoding="utf-8")
    return 0 if not report.blockers else 2


if __name__ == "__main__":
    sys.exit(main())
