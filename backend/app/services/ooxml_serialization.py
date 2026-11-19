"""Serialize OOXML elements without ElementTree's process-global namespace map.

``openpyxl`` registers namespace prefixes globally in ``xml.etree.ElementTree``.
The registrations are process-wide and can therefore change otherwise unrelated
payroll exports. This module deliberately builds the two tables required by
ElementTree's XML serializer from caller-supplied, per-call namespace data.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Mapping
from typing import Literal, overload


_XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"


@overload
def serialize_ooxml(
    element: ET.Element,
    *,
    encoding: Literal["unicode"],
    xml_declaration: bool | None = None,
    namespaces: Mapping[str, str] | None = None,
) -> str: ...


@overload
def serialize_ooxml(
    element: ET.Element,
    *,
    encoding: Literal["UTF-8", "utf-8"] = "UTF-8",
    xml_declaration: bool | None = None,
    namespaces: Mapping[str, str] | None = None,
) -> bytes: ...


def serialize_ooxml(
    element: ET.Element,
    *,
    encoding: Literal["UTF-8", "utf-8", "unicode"] = "UTF-8",
    xml_declaration: bool | None = None,
    namespaces: Mapping[str, str] | None = None,
) -> bytes | str:
    """Return ElementTree-compatible XML using only local namespace state.

    ``namespaces`` maps XML prefixes to namespace URIs. Only namespaces used
    by a QName are declared. Unknown namespace URIs receive deterministic
    ``ns0``, ``ns1``, ... prefixes. The function neither reads nor changes
    ``ElementTree._namespace_map``. Lexical prefixes in attribute values (such
    as ``mc:Ignorable``) remain the caller's responsibility, matching
    ``ElementTree.tostring``.
    """

    normalized_encoding = encoding.lower()
    if normalized_encoding not in {"utf-8", "unicode"}:
        raise ValueError("encoding must be 'UTF-8', 'utf-8', or 'unicode'")

    qnames, namespace_declarations = _local_namespace_tables(element, namespaces)
    chunks: list[str] = []
    declared_encoding = "utf-8" if normalized_encoding == "unicode" else encoding
    if xml_declaration:
        chunks.append(f"<?xml version='1.0' encoding='{declared_encoding}'?>\n")

    ET._serialize_xml(  # type: ignore[attr-defined]
        chunks.append,
        element,
        qnames,
        namespace_declarations,
        short_empty_elements=True,
    )
    serialized = "".join(chunks)
    if normalized_encoding == "unicode":
        return serialized
    return serialized.encode("utf-8")


def _local_namespace_tables(
    element: ET.Element,
    supplied_namespaces: Mapping[str, str] | None,
) -> tuple[dict[object, str | None], dict[str, str]]:
    preferred_by_uri, reserved_prefixes = _validate_namespaces(supplied_namespaces)
    qnames: dict[object, str | None] = {None: None}
    declarations: dict[str, str] = {}

    def prefix_for(uri: str) -> str:
        if uri == _XML_NAMESPACE:
            return "xml"
        if uri in declarations:
            return declarations[uri]

        prefix = preferred_by_uri.get(uri)
        if prefix is None:
            fallback_index = len(declarations)
            while True:
                candidate = f"ns{fallback_index}"
                fallback_index += 1
                if candidate not in reserved_prefixes:
                    prefix = candidate
                    reserved_prefixes.add(candidate)
                    break
        declarations[uri] = prefix
        return prefix

    def add_qname(value: object) -> None:
        if isinstance(value, ET.QName):
            value = value.text
        try:
            if value[:1] == "{":  # type: ignore[index]
                uri, local_name = value[1:].rsplit("}", 1)  # type: ignore[index,union-attr]
                prefix = prefix_for(uri)
                qnames[value] = f"{prefix}:{local_name}" if prefix else local_name
            else:
                qnames[value] = value  # type: ignore[assignment]
        except TypeError:
            ET._raise_serialization_error(value)  # type: ignore[attr-defined]

    for current in element.iter():
        tag = current.tag
        if isinstance(tag, (str, ET.QName)):
            key = tag.text if isinstance(tag, ET.QName) else tag
            if key not in qnames:
                add_qname(key)
        elif tag is not None and tag is not ET.Comment and tag is not ET.ProcessingInstruction:
            ET._raise_serialization_error(tag)  # type: ignore[attr-defined]

        for attribute_name, attribute_value in current.items():
            key = attribute_name.text if isinstance(attribute_name, ET.QName) else attribute_name
            if key not in qnames:
                add_qname(key)
            if isinstance(attribute_value, ET.QName) and attribute_value.text not in qnames:
                add_qname(attribute_value.text)
        text = current.text
        if isinstance(text, ET.QName) and text.text not in qnames:
            add_qname(text.text)

    return qnames, declarations


def _validate_namespaces(
    namespaces: Mapping[str, str] | None,
) -> tuple[dict[str, str], set[str]]:
    preferred_by_uri: dict[str, str] = {_XML_NAMESPACE: "xml"}
    reserved_prefixes = {"xml", "xmlns"}
    if namespaces is None:
        return preferred_by_uri, reserved_prefixes

    for prefix, uri in namespaces.items():
        if not isinstance(prefix, str) or not isinstance(uri, str):
            raise TypeError("namespace prefixes and URIs must be strings")
        if prefix == "xmlns":
            raise ValueError("the 'xmlns' prefix is reserved")
        if prefix == "xml" and uri != _XML_NAMESPACE:
            raise ValueError("the 'xml' prefix must use the XML namespace URI")
        if uri == _XML_NAMESPACE and prefix != "xml":
            raise ValueError("the XML namespace URI must use the 'xml' prefix")
        previous = preferred_by_uri.get(uri)
        if previous is not None and previous != prefix:
            raise ValueError(f"namespace URI {uri!r} has more than one prefix")
        preferred_by_uri[uri] = prefix
        reserved_prefixes.add(prefix)
    return preferred_by_uri, reserved_prefixes
