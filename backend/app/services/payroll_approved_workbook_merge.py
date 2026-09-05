from __future__ import annotations

import posixpath
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from io import BytesIO
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo

from app.services.payroll_month_xlsx_service import (
    PAYROLL_MONTH_TEMPLATE_LAYOUT,
    _payroll_month_app_properties,
    _payroll_month_content_types,
    _payroll_month_sheet_relationships,
    _payroll_month_workbook_relationships,
    _payroll_month_workbook_xml,
    unique_payroll_month_sheet_names,
)


_CONTENT_TYPES_PATH = "[Content_Types].xml"
_APP_PROPERTIES_PATH = "docProps/app.xml"
_WORKBOOK_PATH = "xl/workbook.xml"
_WORKBOOK_RELATIONSHIPS_PATH = "xl/_rels/workbook.xml.rels"
_SHEET_PATH = PAYROLL_MONTH_TEMPLATE_LAYOUT.worksheet_path
_STYLES_PATH = PAYROLL_MONTH_TEMPLATE_LAYOUT.styles_path
_SHEET_RELATIONSHIPS_PATH = "xl/worksheets/_rels/sheet1.xml.rels"
_DRAWING_PATH = "xl/drawings/drawing1.xml"
_DRAWING_RELATIONSHIPS_PATH = "xl/drawings/_rels/drawing1.xml.rels"
_IMAGE_PATH = "xl/media/image1.png"

_STANDARD_SINGLE_WORKBOOK_PARTS = frozenset(
    {
        _CONTENT_TYPES_PATH,
        "_rels/.rels",
        _APP_PROPERTIES_PATH,
        "docProps/core.xml",
        _WORKBOOK_PATH,
        _WORKBOOK_RELATIONSHIPS_PATH,
        _SHEET_PATH,
        _SHEET_RELATIONSHIPS_PATH,
        _STYLES_PATH,
        "xl/sharedStrings.xml",
        "xl/theme/theme1.xml",
        _DRAWING_PATH,
        _DRAWING_RELATIONSHIPS_PATH,
        _IMAGE_PATH,
    }
)
_GENERATED_PARTS = frozenset(
    {
        _CONTENT_TYPES_PATH,
        _APP_PROPERTIES_PATH,
        _WORKBOOK_PATH,
        _WORKBOOK_RELATIONSHIPS_PATH,
        _SHEET_PATH,
        _SHEET_RELATIONSHIPS_PATH,
        _DRAWING_PATH,
        _DRAWING_RELATIONSHIPS_PATH,
    }
)

_PACKAGE_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_DOCUMENT_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_WORKSHEET_RELATIONSHIP_TYPE = f"{_DOCUMENT_RELATIONSHIPS_NS}/worksheet"
_DRAWING_RELATIONSHIP_TYPE = f"{_DOCUMENT_RELATIONSHIPS_NS}/drawing"
_IMAGE_RELATIONSHIP_TYPE = f"{_DOCUMENT_RELATIONSHIPS_NS}/image"


@dataclass(frozen=True)
class _ApprovedWorkbook:
    label: str
    parts: dict[str, bytes]
    infos: dict[str, ZipInfo]


def merge_approved_payroll_workbooks(workbooks: list[tuple[str, bytes]]) -> bytes:
    """Combine compatible, approved single-person payroll exports without rebuilding cells.

    Every input must be an unmodified one-sheet workbook produced from the normal payroll
    template. Worksheet XML is copied byte-for-byte. Package-level workbook metadata and
    relationships are the only parts rebuilt for the resulting multi-sheet workbook.
    """
    if not workbooks:
        raise ValueError("Mindestens ein freigegebener Monatszettel ist erforderlich.")

    approved = [
        _read_approved_workbook(index=index, requested_name=name, content=content)
        for index, (name, content) in enumerate(workbooks, start=1)
    ]
    _ensure_compatible(approved)

    sheet_names = unique_payroll_month_sheet_names(name for name, _content in workbooks)
    first = approved[0]
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path, info in first.infos.items():
            if path not in _GENERATED_PARTS:
                archive.writestr(info, first.parts[path])

        archive.writestr(
            _CONTENT_TYPES_PATH,
            _payroll_month_content_types(first.parts[_CONTENT_TYPES_PATH], len(approved)),
        )
        archive.writestr(
            _APP_PROPERTIES_PATH,
            _payroll_month_app_properties(first.parts[_APP_PROPERTIES_PATH], sheet_names),
        )
        archive.writestr(
            _WORKBOOK_PATH,
            _payroll_month_workbook_xml(first.parts[_WORKBOOK_PATH], sheet_names),
        )
        archive.writestr(
            _WORKBOOK_RELATIONSHIPS_PATH,
            _payroll_month_workbook_relationships(
                first.parts[_WORKBOOK_RELATIONSHIPS_PATH], len(approved)
            ),
        )

        for index, workbook in enumerate(approved, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", workbook.parts[_SHEET_PATH])
            archive.writestr(
                f"xl/worksheets/_rels/sheet{index}.xml.rels",
                _payroll_month_sheet_relationships(
                    workbook.parts[_SHEET_RELATIONSHIPS_PATH], index
                ),
            )
            archive.writestr(f"xl/drawings/drawing{index}.xml", workbook.parts[_DRAWING_PATH])
            archive.writestr(
                f"xl/drawings/_rels/drawing{index}.xml.rels",
                workbook.parts[_DRAWING_RELATIONSHIPS_PATH],
            )

    result = output.getvalue()
    _validate_merged_workbook(result, sheet_names)
    return result


def _read_approved_workbook(
    *, index: int, requested_name: str, content: bytes
) -> _ApprovedWorkbook:
    label = f"Workbook {index} ({requested_name!r})"
    if not isinstance(requested_name, str):
        raise ValueError(f"Workbook {index}: Der Blattname muss Text sein.")
    if not isinstance(content, bytes) or not content:
        raise ValueError(f"{label}: Es wurden keine gültigen XLSX-Bytes übergeben.")

    try:
        with ZipFile(BytesIO(content), "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ValueError(f"{label}: Das XLSX enthält doppelte Paketpfade.")
            if any(info.is_dir() for info in infos):
                raise ValueError(f"{label}: Das XLSX entspricht nicht dem normalen Standardexport.")
            broken_part = archive.testzip()
            if broken_part is not None:
                raise ValueError(f"{label}: Der ZIP-Eintrag {broken_part!r} ist beschädigt.")
            parts = {info.filename: archive.read(info.filename) for info in infos}
    except (BadZipFile, EOFError, NotImplementedError, OSError, RuntimeError) as exc:
        raise ValueError(f"{label}: Kein lesbarer normaler XLSX-Export.") from exc

    actual_parts = set(parts)
    if actual_parts != _STANDARD_SINGLE_WORKBOOK_PARTS:
        missing = sorted(_STANDARD_SINGLE_WORKBOOK_PARTS - actual_parts)
        unexpected = sorted(actual_parts - _STANDARD_SINGLE_WORKBOOK_PARTS)
        details: list[str] = []
        if missing:
            details.append(f"fehlend: {', '.join(missing)}")
        if unexpected:
            details.append(f"unerwartet: {', '.join(unexpected)}")
        raise ValueError(f"{label}: Inkompatibler XLSX-Aufbau ({'; '.join(details)}).")

    for path in (
        _CONTENT_TYPES_PATH,
        _APP_PROPERTIES_PATH,
        _WORKBOOK_PATH,
        _WORKBOOK_RELATIONSHIPS_PATH,
        _SHEET_RELATIONSHIPS_PATH,
    ):
        try:
            parts[path].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(
                f"{label}: {path!r} verwendet nicht die Kodierung des Standardexports."
            ) from exc

    _validate_xml_parts(parts, label)
    _validate_relative_relationships(parts, label)
    _validate_single_workbook_topology(parts, label)
    return _ApprovedWorkbook(
        label=label,
        parts=parts,
        infos={info.filename: info for info in infos},
    )


def _ensure_compatible(workbooks: list[_ApprovedWorkbook]) -> None:
    first = workbooks[0]
    for workbook in workbooks[1:]:
        if workbook.parts[_STYLES_PATH] != first.parts[_STYLES_PATH]:
            raise ValueError(
                f"{workbook.label}: Die Styles unterscheiden sich vom ersten "
                "Standardexport; ein verlustfreier Merge ist nicht möglich."
            )
        if workbook.parts[_IMAGE_PATH] != first.parts[_IMAGE_PATH]:
            raise ValueError(
                f"{workbook.label}: Das Logo unterscheidet sich vom ersten "
                "Standardexport; ein verlustfreier Merge ist nicht möglich."
            )

        for path in sorted(_STANDARD_SINGLE_WORKBOOK_PARTS - {_SHEET_PATH}):
            if path in {_WORKBOOK_PATH, _APP_PROPERTIES_PATH}:
                continue
            if workbook.parts[path] != first.parts[path]:
                raise ValueError(
                    f"{workbook.label}: Der OOXML-Teil {path!r} unterscheidet sich "
                    "vom ersten Standardexport; ein verlustfreier Merge ist nicht möglich."
                )

        sentinel_name = ["__MERGE_VALIDATION__"]
        if _payroll_month_workbook_xml(
            workbook.parts[_WORKBOOK_PATH], sentinel_name
        ) != _payroll_month_workbook_xml(first.parts[_WORKBOOK_PATH], sentinel_name):
            raise ValueError(
                f"{workbook.label}: Die Workbook-Metadaten sind nicht mit dem ersten "
                "Standardexport kompatibel."
            )
        if _payroll_month_app_properties(
            workbook.parts[_APP_PROPERTIES_PATH], sentinel_name
        ) != _payroll_month_app_properties(first.parts[_APP_PROPERTIES_PATH], sentinel_name):
            raise ValueError(
                f"{workbook.label}: Die Dokumenteigenschaften sind nicht mit dem ersten "
                "Standardexport kompatibel."
            )


def _validate_xml_parts(parts: dict[str, bytes], label: str) -> None:
    for path, content in parts.items():
        if not (path.endswith(".xml") or path.endswith(".rels")):
            continue
        try:
            ET.fromstring(content)
        except ET.ParseError as exc:
            raise ValueError(f"{label}: Ungültiges XML in {path!r}.") from exc


def _validate_relative_relationships(parts: dict[str, bytes], label: str) -> None:
    for relationships_path in sorted(path for path in parts if path.endswith(".rels")):
        relationships = _relationships(parts[relationships_path])
        ids: set[str] = set()
        base_path = _relationship_base_path(relationships_path)
        for relationship in relationships:
            relationship_id = relationship.get("Id")
            target = relationship.get("Target")
            if not relationship_id or not target or not relationship.get("Type"):
                raise ValueError(f"{label}: Unvollständige Beziehung in {relationships_path!r}.")
            if relationship_id in ids:
                raise ValueError(
                    f"{label}: Doppelte Beziehungs-ID {relationship_id!r} in "
                    f"{relationships_path!r}."
                )
            ids.add(relationship_id)
            if relationship.get("TargetMode") == "External":
                raise ValueError(
                    f"{label}: Externe Beziehungen sind im normalen Standardexport nicht zulässig."
                )
            if target.startswith("/") or "?" in target or "#" in target:
                raise ValueError(f"{label}: Nicht unterstütztes Beziehungsziel {target!r}.")
            resolved = posixpath.normpath(posixpath.join(base_path, target))
            if resolved == ".." or resolved.startswith("../") or resolved not in parts:
                raise ValueError(
                    f"{label}: Das Beziehungsziel {target!r} aus "
                    f"{relationships_path!r} ist nicht vorhanden."
                )


def _validate_single_workbook_topology(parts: dict[str, bytes], label: str) -> None:
    workbook_root = ET.fromstring(parts[_WORKBOOK_PATH])
    sheets = workbook_root.findall(f"{{{_SPREADSHEET_NS}}}sheets/{{{_SPREADSHEET_NS}}}sheet")
    if len(sheets) != 1:
        raise ValueError(f"{label}: Erwartet wird genau ein Monatsblatt.")

    workbook_relationships = _relationship_map(parts[_WORKBOOK_RELATIONSHIPS_PATH])
    sheet_relationship_id = sheets[0].get(f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}id")
    sheet_relationship = workbook_relationships.get(sheet_relationship_id or "")
    if (
        sheet_relationship is None
        or sheet_relationship.get("Type") != _WORKSHEET_RELATIONSHIP_TYPE
        or sheet_relationship.get("Target") != "worksheets/sheet1.xml"
    ):
        raise ValueError(
            f"{label}: Das Monatsblatt verweist nicht auf die Standard-Worksheet-Datei."
        )
    worksheet_relationships = [
        relationship
        for relationship in workbook_relationships.values()
        if relationship.get("Type") == _WORKSHEET_RELATIONSHIP_TYPE
    ]
    if len(worksheet_relationships) != 1:
        raise ValueError(f"{label}: Erwartet wird genau eine Worksheet-Beziehung.")

    sheet_root = ET.fromstring(parts[_SHEET_PATH])
    drawing_nodes = sheet_root.findall(f"{{{_SPREADSHEET_NS}}}drawing")
    sheet_relationships = _relationship_map(parts[_SHEET_RELATIONSHIPS_PATH])
    if len(drawing_nodes) != 1 or len(sheet_relationships) != 1:
        raise ValueError(f"{label}: Die Standard-Zeichnungsbeziehung fehlt.")
    drawing_relationship_id = drawing_nodes[0].get(f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}id")
    drawing_relationship = sheet_relationships.get(drawing_relationship_id or "")
    if (
        drawing_relationship is None
        or drawing_relationship.get("Type") != _DRAWING_RELATIONSHIP_TYPE
        or drawing_relationship.get("Target") != "../drawings/drawing1.xml"
    ):
        raise ValueError(f"{label}: Das Worksheet verweist nicht auf drawing1.xml.")

    drawing_relationships = _relationship_map(parts[_DRAWING_RELATIONSHIPS_PATH])
    image_relationships = [
        relationship
        for relationship in drawing_relationships.values()
        if relationship.get("Type") == _IMAGE_RELATIONSHIP_TYPE
    ]
    if (
        len(drawing_relationships) != 1
        or len(image_relationships) != 1
        or image_relationships[0].get("Target") != "../media/image1.png"
    ):
        raise ValueError(f"{label}: Die Standard-Logo-Beziehung fehlt.")

    drawing_root = ET.fromstring(parts[_DRAWING_PATH])
    embedded_relationship_ids = {
        value
        for element in drawing_root.iter()
        for attribute, value in element.attrib.items()
        if attribute
        in {
            f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}embed",
            f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}link",
        }
    }
    if embedded_relationship_ids != set(drawing_relationships):
        raise ValueError(f"{label}: Die Logo-Referenz im Drawing ist inkonsistent.")

    content_types_root = ET.fromstring(parts[_CONTENT_TYPES_PATH])
    overrides = {
        element.get("PartName"): element.get("ContentType")
        for element in content_types_root.findall(f"{{{_CONTENT_TYPES_NS}}}Override")
    }
    if "/xl/worksheets/sheet1.xml" not in overrides:
        raise ValueError(f"{label}: Der Content-Type für sheet1.xml fehlt.")
    if "/xl/drawings/drawing1.xml" not in overrides:
        raise ValueError(f"{label}: Der Content-Type für drawing1.xml fehlt.")


def _validate_merged_workbook(content: bytes, sheet_names: list[str]) -> None:
    label = "Zusammengeführtes Workbook"
    try:
        with ZipFile(BytesIO(content), "r") as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or archive.testzip() is not None:
                raise ValueError(f"{label}: Das erzeugte XLSX-Paket ist beschädigt.")
            parts = {name: archive.read(name) for name in names}
    except (BadZipFile, EOFError, NotImplementedError, OSError, RuntimeError) as exc:
        raise ValueError(f"{label}: Das erzeugte XLSX-Paket ist nicht lesbar.") from exc

    _validate_xml_parts(parts, label)
    _validate_relative_relationships(parts, label)

    workbook_root = ET.fromstring(parts[_WORKBOOK_PATH])
    sheets = workbook_root.findall(f"{{{_SPREADSHEET_NS}}}sheets/{{{_SPREADSHEET_NS}}}sheet")
    if [sheet.get("name") for sheet in sheets] != sheet_names:
        raise ValueError(f"{label}: Die Blattnamen wurden nicht korrekt geschrieben.")
    relationships = _relationship_map(parts[_WORKBOOK_RELATIONSHIPS_PATH])
    for index, sheet in enumerate(sheets, start=1):
        relationship_id = sheet.get(f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}id")
        relationship = relationships.get(relationship_id or "")
        if (
            relationship is None
            or relationship.get("Type") != _WORKSHEET_RELATIONSHIP_TYPE
            or relationship.get("Target") != f"worksheets/sheet{index}.xml"
        ):
            raise ValueError(f"{label}: Ungültige Worksheet-Beziehung für Blatt {index}.")

        sheet_relationships = _relationship_map(parts[f"xl/worksheets/_rels/sheet{index}.xml.rels"])
        drawing_relationships = [
            item
            for item in sheet_relationships.values()
            if item.get("Type") == _DRAWING_RELATIONSHIP_TYPE
        ]
        if (
            len(sheet_relationships) != 1
            or len(drawing_relationships) != 1
            or drawing_relationships[0].get("Target") != f"../drawings/drawing{index}.xml"
        ):
            raise ValueError(f"{label}: Ungültige Drawing-Beziehung für Blatt {index}.")

    content_types_root = ET.fromstring(parts[_CONTENT_TYPES_PATH])
    overrides = {
        element.get("PartName")
        for element in content_types_root.findall(f"{{{_CONTENT_TYPES_NS}}}Override")
    }
    expected_generated_overrides = {
        path
        for index in range(1, len(sheet_names) + 1)
        for path in (
            f"/xl/worksheets/sheet{index}.xml",
            f"/xl/drawings/drawing{index}.xml",
        )
    }
    if not expected_generated_overrides.issubset(overrides):
        raise ValueError(f"{label}: Die Content-Types der Monatsblätter sind unvollständig.")


def _relationships(content: bytes) -> list[ET.Element]:
    return list(ET.fromstring(content).findall(f"{{{_PACKAGE_RELATIONSHIPS_NS}}}Relationship"))


def _relationship_map(content: bytes) -> dict[str, ET.Element]:
    return {relationship.get("Id", ""): relationship for relationship in _relationships(content)}


def _relationship_base_path(relationships_path: str) -> str:
    if relationships_path == "_rels/.rels":
        return ""
    directory, separator, relationship_name = relationships_path.rpartition("/_rels/")
    if not separator or not relationship_name.endswith(".rels"):
        raise ValueError(f"Unbekannter OOXML-Beziehungspfad: {relationships_path!r}.")
    source_name = relationship_name.removesuffix(".rels")
    return posixpath.dirname(posixpath.join(directory, source_name))
