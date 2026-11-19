from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services.ooxml_serialization import serialize_ooxml


SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MARKUP_COMPATIBILITY_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
X14AC_NS = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"
XR3_NS = "http://schemas.microsoft.com/office/spreadsheetml/2016/revision3"
XML_NS = "http://www.w3.org/XML/1998/namespace"
SHEET_NAMESPACES = {
    "": SPREADSHEET_NS,
    "r": RELATIONSHIPS_NS,
    "mc": MARKUP_COMPATIBILITY_NS,
    "x14ac": X14AC_NS,
    "xr3": XR3_NS,
}


def _representative_element() -> ET.Element:
    root = ET.Element(ET.QName(SPREADSHEET_NS, "worksheet"))
    root.set(ET.QName(XML_NS, "space"), "preserve")
    root.set("escaped", 'quote=" amp=& less=< tab=\t line=\n return=\r')
    child = ET.SubElement(root, ET.QName(SPREADSHEET_NS, "sheet"))
    child.set(ET.QName(RELATIONSHIPS_NS, "id"), "rId1")
    child.set("kind", ET.QName(RELATIONSHIPS_NS, "hyperlink"))
    child.text = "A & B < C > D"
    comment = ET.Comment("preserved comment")
    comment.tail = "tail & < >"
    root.append(comment)
    return root


@pytest.mark.parametrize(
    ("encoding", "xml_declaration"),
    [
        ("UTF-8", None),
        ("UTF-8", False),
        ("UTF-8", True),
        ("utf-8", True),
        ("unicode", None),
        ("unicode", False),
        ("unicode", True),
    ],
)
def test_matches_elementtree_bytes_with_normal_namespace_map(
    monkeypatch: pytest.MonkeyPatch,
    encoding: str,
    xml_declaration: bool | None,
) -> None:
    normal_map = {
        SPREADSHEET_NS: "",
        RELATIONSHIPS_NS: "r",
        XML_NS: "xml",
    }
    monkeypatch.setattr(ET, "_namespace_map", normal_map)
    element = _representative_element()

    expected = ET.tostring(
        element,
        encoding=encoding,
        xml_declaration=xml_declaration,
    )
    actual = serialize_ooxml(
        element,
        encoding=encoding,  # type: ignore[arg-type]
        xml_declaration=xml_declaration,
        namespaces=SHEET_NAMESPACES,
    )

    assert actual == expected
    assert isinstance(actual, str if encoding == "unicode" else bytes)


def test_lexical_ignorable_prefixes_remain_unused_for_elementtree_parity() -> None:
    root = ET.Element(
        f"{{{SPREADSHEET_NS}}}worksheet",
        {f"{{{MARKUP_COMPATIBILITY_NS}}}Ignorable": "x14ac xr3"},
    )

    actual = serialize_ooxml(root, encoding="unicode", namespaces=SHEET_NAMESPACES)

    assert actual == (
        f'<worksheet xmlns="{SPREADSHEET_NS}" '
        f'xmlns:mc="{MARKUP_COMPATIBILITY_NS}" '
        'mc:Ignorable="x14ac xr3" />'
    )
    assert "xmlns:r=" not in actual
    assert "xmlns:x14ac=" not in actual
    assert "xmlns:xr3=" not in actual


def test_foreign_global_namespace_map_is_ignored_and_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    foreign_map = {
        SPREADSHEET_NS: "s",
        RELATIONSHIPS_NS: "relationships",
        "urn:unrelated": "foreign",
    }
    before = foreign_map.copy()
    monkeypatch.setattr(ET, "_namespace_map", foreign_map)
    root = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
    ET.SubElement(root, f"{{{SPREADSHEET_NS}}}sheet").set(
        f"{{{RELATIONSHIPS_NS}}}id", "rId1"
    )

    actual = serialize_ooxml(root, namespaces=SHEET_NAMESPACES)

    assert actual == (
        f'<worksheet xmlns="{SPREADSHEET_NS}" xmlns:r="{RELATIONSHIPS_NS}">'
        '<sheet r:id="rId1" /></worksheet>'
    ).encode()
    assert ET._namespace_map is foreign_map
    assert foreign_map == before


def test_parallel_calls_keep_prefix_mappings_isolated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    foreign_map = {SPREADSHEET_NS: "globally-mutated"}
    before = foreign_map.copy()
    monkeypatch.setattr(ET, "_namespace_map", foreign_map)
    extension_uri = "urn:thread-local-extension"

    def render(prefix: str) -> bytes:
        root = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
        ET.SubElement(root, f"{{{extension_uri}}}extension")
        result = serialize_ooxml(
            root,
            namespaces={"": SPREADSHEET_NS, prefix: extension_uri},
        )
        assert isinstance(result, bytes)
        return result

    prefixes = ["alpha", "beta", "gamma", "delta"] * 64
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(render, prefixes))

    for prefix, result in zip(prefixes, results, strict=True):
        assert f"xmlns:{prefix}=\"{extension_uri}\"".encode() in result
        assert f"<{prefix}:extension />".encode() in result
    assert ET._namespace_map is foreign_map
    assert foreign_map == before


def test_unknown_namespaces_receive_deterministic_collision_free_prefixes() -> None:
    first_uri = "urn:unknown:first"
    second_uri = "urn:unknown:second"
    root = ET.Element(f"{{{first_uri}}}root", {f"{{{second_uri}}}flag": "yes"})
    ET.SubElement(root, f"{{{second_uri}}}child")

    results = {
        serialize_ooxml(
            root,
            encoding="unicode",
            namespaces={"ns0": "urn:reserved-but-unused"},
        )
        for _ in range(32)
    }

    assert results == {
        f'<ns1:root xmlns:ns1="{first_uri}" xmlns:ns2="{second_uri}" '
        'ns2:flag="yes"><ns2:child /></ns1:root>'
    }


def test_unknown_prefix_number_counts_used_namespaces_and_skips_reserved_prefixes() -> None:
    extension_uri = "urn:unknown:extension"
    root = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
    ET.SubElement(root, f"{{{extension_uri}}}extension")

    ordinary = serialize_ooxml(
        root,
        encoding="unicode",
        namespaces={"": SPREADSHEET_NS},
    )
    with_reserved_ns1 = serialize_ooxml(
        root,
        encoding="unicode",
        namespaces={"": SPREADSHEET_NS, "ns1": "urn:reserved-but-unused"},
    )

    assert ordinary == (
        f'<worksheet xmlns="{SPREADSHEET_NS}" xmlns:ns1="{extension_uri}">'
        '<ns1:extension /></worksheet>'
    )
    assert with_reserved_ns1 == (
        f'<worksheet xmlns="{SPREADSHEET_NS}" xmlns:ns2="{extension_uri}">'
        '<ns2:extension /></worksheet>'
    )


def test_qname_text_failure_matches_elementtree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    normal_map = {SPREADSHEET_NS: "", RELATIONSHIPS_NS: "r"}
    monkeypatch.setattr(ET, "_namespace_map", normal_map)
    root = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
    root.text = ET.QName(RELATIONSHIPS_NS, "hyperlink")  # type: ignore[assignment]

    with pytest.raises(TypeError) as reference_error:
        ET.tostring(root, encoding="unicode")
    with pytest.raises(TypeError, match=re.escape(str(reference_error.value))):
        serialize_ooxml(root, encoding="unicode", namespaces=SHEET_NAMESPACES)


def test_rejects_encodings_outside_supported_contract() -> None:
    with pytest.raises(ValueError, match="encoding must be"):
        serialize_ooxml(ET.Element("root"), encoding="us-ascii")  # type: ignore[arg-type]
