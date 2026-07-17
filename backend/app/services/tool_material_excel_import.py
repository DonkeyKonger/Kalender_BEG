from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.audit_log import AuditLog
from app.models.enums import ToolMaterialStatus
from app.models.person import Person
from app.models.tool_issue_report import ToolIssueReport
from app.models.tool_material_item import ToolMaterialItem
from app.services.tool_material_category import suggest_tool_material_category


SOURCE_NAME = "beg_maschinen_werkzeugliste"
SOURCE_SHEET = "Maschinen"
EXPECTED_HEADERS = (
    "Nr.",
    "Fabrikat",
    "Bezeichnung",
    "Typ",
    "Gerätenummer",
    "Seriennummer",
    "Mitarbeiter",
    "Datum",
    "Lieferschein",
    "Bemerkungen",
    "Lieferant",
    "RG-Nr.",
    "Bestand",
    "Auswahl",
)
PHYSICAL_DATA_HEADERS = (
    "Fabrikat",
    "Bezeichnung",
    "Typ",
    "Gerätenummer",
    "Seriennummer",
    "Lieferschein",
    "Bemerkungen",
    "Lieferant",
    "RG-Nr.",
)
STATIC_FIELD_MAP = {
    "manufacturer": "manufacturer",
    "designation": "designation",
    "item_type": "item_type",
    "device_number": "device_number",
    "serial_number": "serial_number",
    "delivery_note": "delivery_note",
    "supplier": "supplier",
    "invoice_number": "invoice_number",
}
BUILTIN_DATE_FORMATS = set(range(14, 23)) | set(range(27, 37)) | {45, 46, 47, 50, 57}


@dataclass(frozen=True)
class ExcelCell:
    value: str | Decimal | bool | None
    numeric: bool = False
    number_format: str = ""


@dataclass(frozen=True)
class SourceToolRow:
    row_number: int
    beg_number: str | None
    manufacturer: str | None
    designation: str
    item_type: str | None
    device_number: str | None
    serial_number: str | None
    employee_value: str | None
    item_date: date | None
    delivery_note: str | None
    remarks: str | None
    supplier: str | None
    invoice_number: str | None
    stock: int
    import_key: str

    def canonical_tuple(self) -> tuple[str, ...]:
        return tuple(
            normalize_identity(value)
            for value in (
                self.beg_number,
                self.manufacturer,
                self.designation,
                self.item_type,
                self.device_number,
                self.serial_number,
            )
        )

    def physical_key(self) -> tuple[str, str, str] | None:
        if not self.beg_number or not (self.device_number or self.serial_number):
            return None
        return (
            normalize_identity(self.beg_number),
            normalize_identity(self.device_number),
            normalize_identity(self.serial_number),
        )


@dataclass
class EmployeeMapping:
    source_value: str
    count: int
    status: str
    person_id: int | None = None
    person_name: str | None = None
    candidates: list[dict] = field(default_factory=list)


@dataclass
class ImportReport:
    mode: str
    file: str
    sheet: str = SOURCE_SHEET
    read_excel_rows: int = 0
    stock_one_rows: int = 0
    invalid_rows: list[dict] = field(default_factory=list)
    valid_source_rows: int = 0
    duplicate_groups: list[dict] = field(default_factory=list)
    physical_tool_rows: int = 0
    unnumbered_rows: int = 0
    company_stock_rows: int = 0
    missing_optional_fields: dict[str, int] = field(default_factory=dict)
    employee_mappings: list[dict] = field(default_factory=list)
    existing_matches: int = 0
    creates: int = 0
    updates: int = 0
    unchanged: int = 0
    ambiguous_existing: list[dict] = field(default_factory=list)
    unresolved_employees: list[dict] = field(default_factory=list)
    ambiguous_employees: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    backup_file: str | None = None
    applied: bool = False
    already_applied: bool = False
    control_checks: dict[str, dict] = field(default_factory=dict)

    @property
    def blockers(self) -> list[str]:
        blockers = list(self.errors)
        if self.unresolved_employees:
            blockers.append("Nicht aufgelöste Mitarbeiterzuordnungen vorhanden.")
        if self.ambiguous_employees:
            blockers.append("Mehrdeutige Mitarbeiterzuordnungen vorhanden.")
        if self.ambiguous_existing:
            blockers.append("Mehrdeutige vorhandene Werkzeugdatensätze vorhanden.")
        return blockers

    def to_dict(self) -> dict:
        result = asdict(self)
        result["blockers"] = self.blockers
        result["ready_to_apply"] = not self.blockers
        return result


def read_source_rows(file_path: Path) -> tuple[list[SourceToolRow], ImportReport]:
    cells_by_row, total_data_rows = read_xlsx_sheet(file_path, SOURCE_SHEET)
    report = ImportReport(mode="source", file=str(file_path), read_excel_rows=total_data_rows)
    if not cells_by_row:
        report.errors.append("Das Tabellenblatt Maschinen ist leer.")
        return [], report

    header_row_number = min(cells_by_row)
    header_cells = cells_by_row[header_row_number]
    headers = tuple(cell_text(header_cells.get(index)) for index in range(1, len(EXPECTED_HEADERS) + 1))
    if headers != EXPECTED_HEADERS:
        report.errors.append(
            f"Unerwartete Spaltenstruktur: erwartet {EXPECTED_HEADERS!r}, gefunden {headers!r}."
        )
        return [], report
    column = {header: index + 1 for index, header in enumerate(headers)}

    valid_rows: list[SourceToolRow] = []
    for row_number in sorted(number for number in cells_by_row if number > header_row_number):
        row = cells_by_row[row_number]
        stock_cell = row.get(column["Bestand"])
        if not is_exact_numeric_one(stock_cell):
            continue
        report.stock_one_rows += 1
        if all(not cell_text(row.get(column[header])) for header in PHYSICAL_DATA_HEADERS):
            report.invalid_rows.append(
                {
                    "row_number": row_number,
                    "beg_number": identifier_text(row.get(column["Nr."])),
                    "employee": cell_text(row.get(column["Mitarbeiter"])),
                    "reason": "Keine Werkzeugdaten vorhanden",
                }
            )
            continue

        beg_number = identifier_text(row.get(column["Nr."]))
        if beg_number == "0":
            beg_number = None
        designation = cell_text(row.get(column["Bezeichnung"]))
        if not designation:
            report.invalid_rows.append(
                {
                    "row_number": row_number,
                    "beg_number": beg_number,
                    "reason": "Bezeichnung fehlt",
                }
            )
            continue
        import_key = stable_source_key(row_number)
        valid_rows.append(
            SourceToolRow(
                row_number=row_number,
                beg_number=beg_number,
                manufacturer=cell_text(row.get(column["Fabrikat"])),
                designation=designation,
                item_type=cell_text(row.get(column["Typ"])),
                device_number=identifier_text(row.get(column["Gerätenummer"])),
                serial_number=identifier_text(row.get(column["Seriennummer"])),
                employee_value=cell_text(row.get(column["Mitarbeiter"])),
                item_date=excel_date(row.get(column["Datum"])),
                delivery_note=identifier_text(row.get(column["Lieferschein"])),
                remarks=cell_text(row.get(column["Bemerkungen"])),
                supplier=cell_text(row.get(column["Lieferant"])),
                invoice_number=identifier_text(row.get(column["RG-Nr."])),
                stock=1,
                import_key=import_key,
            )
        )

    report.valid_source_rows = len(valid_rows)
    report.unnumbered_rows = sum(row.beg_number is None for row in valid_rows)
    report.company_stock_rows = sum(normalize_name(row.employee_value) == "beg" for row in valid_rows)
    report.missing_optional_fields = {
        field_name: sum(getattr(row, field_name) is None for row in valid_rows)
        for field_name in (
            "beg_number",
            "manufacturer",
            "item_type",
            "device_number",
            "serial_number",
            "employee_value",
            "item_date",
            "delivery_note",
            "remarks",
            "supplier",
            "invoice_number",
        )
    }
    deduplicated = deduplicate_source_rows(valid_rows, report)
    report.physical_tool_rows = len(deduplicated)
    validate_source_controls(report, deduplicated)
    return deduplicated, report


def deduplicate_source_rows(rows: list[SourceToolRow], report: ImportReport) -> list[SourceToolRow]:
    groups: dict[tuple[str, str, str], list[SourceToolRow]] = defaultdict(list)
    without_strong_key: list[SourceToolRow] = []
    for row in rows:
        key = row.physical_key()
        if key is None:
            without_strong_key.append(row)
        else:
            groups[key].append(row)

    result = list(without_strong_key)
    for key, group in groups.items():
        if len(group) == 1:
            result.append(group[0])
            continue
        canonical_variants = {row.canonical_tuple() for row in group}
        if len(canonical_variants) != 1:
            # Same technical key with conflicting master data must not be silently merged.
            report.errors.append(
                f"Technischer Schlüssel {key!r} hat widersprüchliche Stammdaten in Zeilen "
                f"{[row.row_number for row in group]}."
            )
            result.extend(group)
            continue
        selected = max(group, key=lambda row: (row.item_date or date.min, row.row_number))
        selected_key = stable_physical_key(key)
        selected = SourceToolRow(**{**asdict(selected), "import_key": selected_key})
        report.duplicate_groups.append(
            {
                "physical_key": list(key),
                "source_rows": [row.row_number for row in group],
                "selected_row": selected.row_number,
                "selected_employee": selected.employee_value,
                "selected_date": selected.item_date.isoformat() if selected.item_date else None,
            }
        )
        result.append(selected)
    return sorted(result, key=lambda row: row.row_number)


def validate_source_controls(report: ImportReport, rows: list[SourceToolRow]) -> None:
    checks = {
        "stock_one_rows": (report.stock_one_rows, 902),
        "invalid_rows": (len(report.invalid_rows), 2),
        "valid_source_rows": (report.valid_source_rows, 900),
        "duplicate_groups": (len(report.duplicate_groups), 2),
        "physical_tool_rows": (report.physical_tool_rows, 898),
        "unnumbered_rows": (report.unnumbered_rows, 33),
        "beg_20000_components": (sum(row.beg_number == "20000" for row in rows), 6),
    }
    report.control_checks = {
        name: {"actual": actual, "expected": expected, "ok": actual == expected}
        for name, (actual, expected) in checks.items()
    }
    for name, check in report.control_checks.items():
        if not check["ok"]:
            report.errors.append(
                f"Kontrollwert {name} abweichend: {check['actual']} statt {check['expected']}."
            )
    if report.company_stock_rows != 281:
        report.errors.append(
            f"Gültige BEG-Zeilen abweichend: {report.company_stock_rows} statt 281."
        )
    report.warnings.append(
        "Die Auftragssumme BEG=282 enthält Excel-Zeile 4044. Nach deren ausdrücklich "
        "gefordertem Ausschluss verbleiben 281 gültige BEG-Zeilen."
    )


class ToolMaterialExcelImporter:
    def __init__(self, db: Session, rows: list[SourceToolRow], report: ImportReport) -> None:
        self.db = db
        self.rows = rows
        self.report = report
        self.people = list(db.scalars(select(Person).options(selectinload(Person.users))).unique())
        self.employee_map = self._resolve_employees()
        self.items = list(
            db.scalars(
                select(ToolMaterialItem).options(selectinload(ToolMaterialItem.issue_reports))
            ).unique()
        )

    def plan(self) -> list[tuple[str, SourceToolRow, ToolMaterialItem | None, dict]]:
        plans: list[tuple[str, SourceToolRow, ToolMaterialItem | None, dict]] = []
        indexes = self._item_indexes()
        matched_ids: set[int] = set()
        for row in self.rows:
            item = self._match_item(row, indexes, matched_ids)
            employee_id = self._employee_id(row.employee_value)
            if item is None:
                plans.append(("create", row, None, self._new_values(row, employee_id)))
                self.report.creates += 1
                continue
            matched_ids.add(item.id)
            self.report.existing_matches += 1
            changes = self._changes_for_existing(item, row, employee_id)
            if changes:
                plans.append(("update", row, item, changes))
                self.report.updates += 1
            else:
                plans.append(("unchanged", row, item, {}))
                self.report.unchanged += 1
        return plans

    def apply(self, plans: list[tuple[str, SourceToolRow, ToolMaterialItem | None, dict]]) -> None:
        if self.report.blockers:
            raise ValueError("Import wegen blockierender Prüfungen nicht ausführbar.")
        for action, _row, item, values in plans:
            if action == "create":
                self.db.add(ToolMaterialItem(**values))
            elif action == "update" and item is not None:
                for field_name, value in values.items():
                    setattr(item, field_name, value)
        self.db.add(
            AuditLog(
                user_id=None,
                action="excel_import",
                entity_type="tool_material_import",
                entity_id=None,
                old_value_json=None,
                new_value_json={
                    "source": SOURCE_NAME,
                    "sheet": SOURCE_SHEET,
                    "physical_rows": self.report.physical_tool_rows,
                    "created": self.report.creates,
                    "updated": self.report.updates,
                    "unchanged": self.report.unchanged,
                },
            )
        )

    def _resolve_employees(self) -> dict[str, int | None]:
        source_counts = Counter(
            row.employee_value.strip() for row in self.rows if row.employee_value and row.employee_value.strip()
        )
        resolved: dict[str, int | None] = {}
        mappings: list[EmployeeMapping] = []
        for source_value, count in sorted(source_counts.items(), key=lambda item: normalize_name(item[0])):
            normalized = normalize_name(source_value)
            if normalized in {"beg", "wohnung hh"}:
                mappings.append(EmployeeMapping(source_value, count, "company_stock"))
                resolved[normalized] = None
                continue
            candidates = self._person_candidates(source_value)
            if len(candidates) == 1:
                person = candidates[0]
                mappings.append(
                    EmployeeMapping(source_value, count, "resolved", person.id, person.display_name)
                )
                resolved[normalized] = person.id
            elif not candidates:
                mapping = EmployeeMapping(source_value, count, "unresolved")
                mappings.append(mapping)
                self.report.unresolved_employees.append(asdict(mapping))
            else:
                candidate_values = [
                    {"person_id": person.id, "person_name": person.display_name}
                    for person in candidates
                ]
                mapping = EmployeeMapping(
                    source_value, count, "ambiguous", candidates=candidate_values
                )
                mappings.append(mapping)
                self.report.ambiguous_employees.append(asdict(mapping))
        self.report.employee_mappings = [asdict(mapping) for mapping in mappings]
        return resolved

    def _person_candidates(self, source_value: str) -> list[Person]:
        needle = normalize_name(source_value)
        is_short_code = source_value.strip().upper() in {"PE", "KE", "TW"}
        matches: list[Person] = []
        for person in self.people:
            user_names = [user.username for user in person.users]
            exact_values = {
                normalize_name(person.display_name),
                normalize_name(f"{person.first_name} {person.last_name}"),
                normalize_name(person.first_name),
                normalize_name(person.last_name),
                *(normalize_name(value) for value in user_names),
            }
            if is_short_code:
                exact_values = {
                    normalize_name(person.short_code),
                    *(normalize_name(value) for value in user_names),
                }
            elif needle == "salzen":
                exact_values.add(normalize_name(person.last_name.removeprefix("von ")))
            else:
                exact_values.add(normalize_name(person.short_code))
            if needle in exact_values:
                matches.append(person)
        return matches

    def _employee_id(self, source_value: str | None) -> int | None:
        if not source_value:
            return None
        return self.employee_map.get(normalize_name(source_value))

    def _item_indexes(self) -> dict[str, dict]:
        by_import_key: dict[str, list[ToolMaterialItem]] = defaultdict(list)
        by_physical: dict[tuple[str, str, str], list[ToolMaterialItem]] = defaultdict(list)
        by_canonical: dict[tuple[str, ...], list[ToolMaterialItem]] = defaultdict(list)
        by_beg: dict[str, list[ToolMaterialItem]] = defaultdict(list)
        for item in self.items:
            if item.import_key:
                by_import_key[item.import_key].append(item)
            physical = item_physical_key(item)
            if physical:
                by_physical[physical].append(item)
            by_canonical[item_canonical_tuple(item)].append(item)
            if item.beg_number:
                by_beg[normalize_identity(item.beg_number)].append(item)
        return {
            "import": by_import_key,
            "physical": by_physical,
            "canonical": by_canonical,
            "beg": by_beg,
        }

    def _match_item(
        self,
        row: SourceToolRow,
        indexes: dict[str, dict],
        matched_ids: set[int],
    ) -> ToolMaterialItem | None:
        candidate_sets: list[list[ToolMaterialItem]] = []
        candidate_sets.append(indexes["import"].get(row.import_key, []))
        if row.physical_key():
            candidate_sets.append(indexes["physical"].get(row.physical_key(), []))
        candidate_sets.append(indexes["canonical"].get(row.canonical_tuple(), []))
        for candidates in candidate_sets:
            available = [item for item in candidates if item.id not in matched_ids]
            if len(available) == 1:
                return available[0]
            if len(available) > 1:
                self._ambiguous_item(row, available, "Eindeutiger Schlüssel mehrfach vorhanden")
                return None

        if not row.beg_number:
            return None
        candidates = [
            item
            for item in indexes["beg"].get(normalize_identity(row.beg_number), [])
            if item.id not in matched_ids and no_static_conflict(item, row)
        ]
        if not candidates:
            return None
        scored = sorted(
            ((static_match_score(item, row), item) for item in candidates),
            key=lambda entry: entry[0],
            reverse=True,
        )
        best_score = scored[0][0]
        best = [item for score, item in scored if score == best_score]
        if len(best) == 1 and (len(candidates) == 1 or best_score >= 2):
            return best[0]
        self._ambiguous_item(row, candidates, "BEG-Nr. ohne eindeutige technische Identität")
        return None

    def _ambiguous_item(
        self, row: SourceToolRow, candidates: list[ToolMaterialItem], reason: str
    ) -> None:
        self.report.ambiguous_existing.append(
            {
                "source_row": row.row_number,
                "beg_number": row.beg_number,
                "candidate_ids": [item.id for item in candidates],
                "reason": reason,
            }
        )

    def _new_values(self, row: SourceToolRow, employee_id: int | None) -> dict:
        remarks = row.remarks
        if normalize_name(row.employee_value) == "wohnung hh":
            remarks = append_once(remarks, "Ursprüngliche Zuordnung: Wohnung HH")
        return {
            "beg_number": row.beg_number,
            "manufacturer": row.manufacturer,
            "designation": row.designation,
            "item_type": row.item_type,
            "device_number": row.device_number,
            "serial_number": row.serial_number,
            "employee_id": employee_id,
            "item_date": row.item_date,
            "delivery_note": row.delivery_note,
            "remarks": remarks,
            "supplier": row.supplier,
            "invoice_number": row.invoice_number,
            "stock": 1,
            "category": suggest_tool_material_category(
                row.designation, row.item_type, row.manufacturer
            ),
            "status": (
                ToolMaterialStatus.ISSUED if employee_id is not None else ToolMaterialStatus.WAREHOUSE
            ),
            "import_source": SOURCE_NAME,
            "import_sheet": SOURCE_SHEET,
            "import_row_number": row.row_number,
            "import_key": row.import_key,
        }

    def _changes_for_existing(
        self, item: ToolMaterialItem, row: SourceToolRow, employee_id: int | None
    ) -> dict:
        changes: dict = {}
        source_values = self._new_values(row, employee_id)
        for target_field in STATIC_FIELD_MAP:
            source_value = source_values[target_field]
            if is_blank(getattr(item, target_field)) and not is_blank(source_value):
                changes[target_field] = source_value
        if item.stock is None:
            changes["stock"] = 1
        if item.import_key is None:
            changes.update(
                import_source=SOURCE_NAME,
                import_sheet=SOURCE_SHEET,
                import_row_number=row.row_number,
                import_key=row.import_key,
            )
        elif item.import_key == row.import_key and item.import_row_number != row.row_number:
            changes["import_row_number"] = row.row_number

        if is_blank(item.remarks) and row.remarks:
            changes["remarks"] = row.remarks
        if normalize_name(row.employee_value) == "wohnung hh":
            current_remarks = changes.get("remarks", item.remarks)
            updated_remarks = append_once(current_remarks, "Ursprüngliche Zuordnung: Wohnung HH")
            if updated_remarks != item.remarks:
                changes["remarks"] = updated_remarks

        # Operative status and newer assignments always win over the workbook snapshot.
        source_is_newer = row.item_date is not None and (
            item.item_date is None or row.item_date > item.item_date
        )
        if item.status != ToolMaterialStatus.WRITTEN_OFF and source_is_newer:
            if item.item_date != row.item_date:
                changes["item_date"] = row.item_date
            if item.employee_id != employee_id:
                changes["employee_id"] = employee_id
                changes["status"] = (
                    ToolMaterialStatus.ISSUED
                    if employee_id is not None
                    else ToolMaterialStatus.WAREHOUSE
                )
        elif item.item_date is None and row.item_date is not None:
            changes["item_date"] = row.item_date
        return {field_name: value for field_name, value in changes.items() if getattr(item, field_name) != value}


def verify_applied_import(
    db: Session, rows: list[SourceToolRow], report: ImportReport
) -> None:
    """Verify coverage and a second no-op plan before the surrounding transaction commits."""
    db.flush()
    verification = ImportReport(
        mode="verification",
        file=report.file,
        physical_tool_rows=len(rows),
    )
    second_importer = ToolMaterialExcelImporter(db, rows, verification)
    second_importer.plan()
    expected_keys = {row.import_key for row in rows}
    imported_items = list(
        db.scalars(select(ToolMaterialItem).where(ToolMaterialItem.import_key.in_(expected_keys)))
    )
    imported_by_key = {item.import_key: item for item in imported_items}

    checks = {
        "post_import_source_keys": (len(imported_by_key), len(rows)),
        "post_import_existing_matches": (verification.existing_matches, len(rows)),
        "idempotency_new_creates": (verification.creates, 0),
        "idempotency_updates": (verification.updates, 0),
        "beg_20000_components_after_import": (
            sum(
                1
                for row in rows
                if row.beg_number == "20000" and row.import_key in imported_by_key
            ),
            6,
        ),
        "unnumbered_after_import": (
            sum(
                1
                for row in rows
                if row.beg_number is None and row.import_key in imported_by_key
            ),
            33,
        ),
    }
    for name, (actual, expected) in checks.items():
        report.control_checks[name] = {
            "actual": actual,
            "expected": expected,
            "ok": actual == expected,
        }
        if actual != expected:
            report.errors.append(
                f"Abschlussprüfung {name} fehlgeschlagen: {actual} statt {expected}."
            )

    for beg_number in ("25081", "25083"):
        source_row = next(row for row in rows if row.beg_number == beg_number)
        item = imported_by_key.get(source_row.import_key)
        expected_employee_id = second_importer._employee_id(source_row.employee_value)
        ok = item is not None and item.employee_id == expected_employee_id
        report.control_checks[f"beg_{beg_number}_current_assignment"] = {
            "actual": item.employee_id if item else None,
            "expected": expected_employee_id,
            "ok": ok,
        }
        if not ok:
            report.errors.append(
                f"Abschlussprüfung für die aktuelle Zuordnung von BEG-Nr. {beg_number} fehlgeschlagen."
            )

    if verification.blockers:
        report.errors.extend(
            f"Abschlussprüfung: {blocker}" for blocker in verification.blockers
        )

    if report.errors:
        raise ValueError("Abschluss- oder Idempotenzprüfung fehlgeschlagen.")


def create_backup(db: Session, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = backup_dir / f"tool_material_items_before_excel_import_{timestamp}.json"
    items = list(
        db.scalars(
            select(ToolMaterialItem).options(selectinload(ToolMaterialItem.issue_reports))
        ).unique()
    )
    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": SOURCE_NAME,
        "items": [serialize_item(item) for item in items],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def serialize_item(item: ToolMaterialItem) -> dict:
    return {
        column.name: serialize_value(getattr(item, column.name))
        for column in ToolMaterialItem.__table__.columns
    } | {
        "issue_reports": [
            {
                column.name: serialize_value(getattr(report, column.name))
                for column in ToolIssueReport.__table__.columns
            }
            for report in item.issue_reports
        ]
    }


def serialize_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "value"):
        return value.value
    return value


def read_xlsx_sheet(
    file_path: Path, sheet_name: str
) -> tuple[dict[int, dict[int, ExcelCell]], int]:
    if not file_path.is_file():
        raise FileNotFoundError(file_path)
    with ZipFile(file_path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relation_targets = {
            relation.attrib["Id"]: relation.attrib["Target"] for relation in rels
        }
        sheet_target = None
        for sheet in workbook.findall("{*}sheets/{*}sheet"):
            if sheet.attrib.get("name") == sheet_name:
                relation_id = sheet.attrib.get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
                )
                sheet_target = relation_targets.get(relation_id)
                break
        if sheet_target is None:
            raise ValueError(f"Tabellenblatt {sheet_name!r} nicht gefunden.")
        sheet_path = "xl/" + sheet_target.removeprefix("/").removeprefix("xl/")
        shared_strings = read_shared_strings(archive)
        formats = read_number_formats(archive)
        sheet = ET.fromstring(archive.read(sheet_path))
        rows: dict[int, dict[int, ExcelCell]] = {}
        max_row = 0
        for row_element in sheet.findall(".//{*}sheetData/{*}row"):
            row_number = int(row_element.attrib["r"])
            max_row = max(max_row, row_number)
            values: dict[int, ExcelCell] = {}
            for cell in row_element.findall("{*}c"):
                column_number = column_index(cell.attrib["r"])
                style_index = int(cell.attrib.get("s", "0"))
                number_format = formats.get(style_index, "")
                cell_type = cell.attrib.get("t")
                raw = cell.findtext("{*}v")
                if cell_type == "inlineStr":
                    value: str | Decimal | bool | None = "".join(
                        text.text or "" for text in cell.findall(".//{*}t")
                    )
                elif raw is None:
                    value = None
                elif cell_type == "s":
                    value = shared_strings[int(raw)]
                elif cell_type in {"str", "e"}:
                    value = raw
                elif cell_type == "b":
                    value = raw == "1"
                else:
                    try:
                        value = Decimal(raw)
                    except InvalidOperation:
                        value = raw
                values[column_number] = ExcelCell(
                    value=value,
                    numeric=isinstance(value, Decimal),
                    number_format=number_format,
                )
            if any(cell.value is not None for cell in values.values()):
                rows[row_number] = values
        meaningful_max_row = max(rows, default=1)
        return rows, max(meaningful_max_row - 1, 0)


def read_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(text.text or "" for text in item.findall(".//{*}t")) for item in root]


def read_number_formats(archive: ZipFile) -> dict[int, str]:
    if "xl/styles.xml" not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read("xl/styles.xml"))
    custom = {
        int(element.attrib["numFmtId"]): element.attrib["formatCode"]
        for element in root.findall("{*}numFmts/{*}numFmt")
    }
    formats: dict[int, str] = {}
    for index, element in enumerate(root.findall("{*}cellXfs/{*}xf")):
        number_format_id = int(element.attrib.get("numFmtId", "0"))
        if number_format_id in custom:
            formats[index] = custom[number_format_id]
        elif number_format_id in BUILTIN_DATE_FORMATS:
            formats[index] = "__date__"
        else:
            formats[index] = ""
    return formats


def column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        raise ValueError(f"Ungültige Zellreferenz: {reference}")
    result = 0
    for character in letters.group(0):
        result = result * 26 + ord(character) - ord("A") + 1
    return result


def cell_text(cell: ExcelCell | None) -> str | None:
    if cell is None or cell.value is None:
        return None
    value = cell.value
    if isinstance(value, Decimal):
        return decimal_text(value)
    if isinstance(value, bool):
        return "1" if value else "0"
    cleaned = str(value).strip()
    return cleaned or None


def is_exact_numeric_one(cell: ExcelCell | None) -> bool:
    return bool(cell and cell.numeric and cell.value == Decimal("1"))


def identifier_text(cell: ExcelCell | None) -> str | None:
    if cell is None or cell.value is None:
        return None
    if not isinstance(cell.value, Decimal):
        return cell_text(cell)
    value = cell.value
    integer = value == value.to_integral_value()
    if integer:
        zero_pattern = numeric_zero_width(cell.number_format)
        digits = decimal_text(value)
        if zero_pattern and not digits.startswith("-"):
            return digits.zfill(zero_pattern)
    return decimal_text(value)


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def numeric_zero_width(number_format: str) -> int:
    if not number_format or number_format == "__date__":
        return 0
    first_section = number_format.split(";", 1)[0]
    cleaned = re.sub(r'"[^"]*"|\[[^]]*\]|\\.|_.|\*.', "", first_section)
    if re.fullmatch(r"0+", cleaned):
        return len(cleaned)
    return 0


def excel_date(cell: ExcelCell | None) -> date | None:
    if cell is None or cell.value is None:
        return None
    if isinstance(cell.value, Decimal):
        return date(1899, 12, 30) + timedelta(days=int(cell.value))
    text = str(cell.value).strip()
    for pattern in ("%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            pass
    raise ValueError(f"Datum {text!r} ist nicht stabil interpretierbar.")


def stable_source_key(row_number: int) -> str:
    return hashlib.sha256(f"{SOURCE_NAME}|{SOURCE_SHEET}|row:{row_number}".encode()).hexdigest()


def stable_physical_key(key: tuple[str, str, str]) -> str:
    return hashlib.sha256(f"{SOURCE_NAME}|{SOURCE_SHEET}|physical:{'|'.join(key)}".encode()).hexdigest()


def normalize_name(value: str | None) -> str:
    if not value:
        return ""
    folded = unicodedata.normalize("NFKD", value.casefold())
    without_accents = "".join(character for character in folded if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", without_accents).strip()


def normalize_identity(value: str | None) -> str:
    return normalize_name(value).replace(" ", "")


def item_canonical_tuple(item: ToolMaterialItem) -> tuple[str, ...]:
    return tuple(
        normalize_identity(value)
        for value in (
            item.beg_number,
            item.manufacturer,
            item.designation,
            item.item_type,
            item.device_number,
            item.serial_number,
        )
    )


def item_physical_key(item: ToolMaterialItem) -> tuple[str, str, str] | None:
    if not item.beg_number or not (item.device_number or item.serial_number):
        return None
    return (
        normalize_identity(item.beg_number),
        normalize_identity(item.device_number),
        normalize_identity(item.serial_number),
    )


def no_static_conflict(item: ToolMaterialItem, row: SourceToolRow) -> bool:
    for field_name in ("manufacturer", "designation", "item_type", "device_number", "serial_number"):
        left = getattr(item, field_name)
        right = getattr(row, field_name)
        if left and right and normalize_identity(left) != normalize_identity(right):
            return False
    return True


def static_match_score(item: ToolMaterialItem, row: SourceToolRow) -> int:
    return sum(
        bool(left and right and normalize_identity(left) == normalize_identity(right))
        for left, right in (
            (item.manufacturer, row.manufacturer),
            (item.designation, row.designation),
            (item.item_type, row.item_type),
            (item.device_number, row.device_number),
            (item.serial_number, row.serial_number),
        )
    )


def append_once(existing: str | None, extra: str) -> str:
    if not existing:
        return extra
    if normalize_name(extra) in normalize_name(existing):
        return existing
    return f"{existing.rstrip()}\n{extra}"


def is_blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())
