"""Restricted storage boundary for the preserved priceviewer file formats.

Source PDFs/DATANORM stay byte-identical. Streamlit/Blob transport is replaced
with the calendar's Graph client. Local storage exists only in isolated tests.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import SplitResult, quote, unquote, urlsplit

from fastapi import HTTPException
from sqlalchemy import text

from app.core.config import settings
from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.material_order_graph_runtime import get_material_order_storage_service

FOLDER_NAME = "Preisvergleich"
FOLDERS = {"offers": "angebote", "datanorm": "datanorm", "cache": "cache"}
STATE_NAME = "calendar_state.json"
MAX_FILE_BYTES = 40 * 1024 * 1024
MAX_BATCH_BYTES = 160 * 1024 * 1024
LOCK_KEY = 5342519017
LEGACY_SETTINGS = {
    "rabatte.json": "discounts",
    "offer_types.json": "offer_types",
    "align_netto.json": "align_netto",
    "manual_prices.json": "manual_prices",
    "tab1_net_price_reference_presets.json": "reference_presets",
}
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def _url_origin(parts: SplitResult) -> tuple[str, str, int] | None:
    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"} or parts.username is not None or parts.password is not None:
        return None
    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if hostname is None:
        return None
    return scheme, hostname.lower(), port or (443 if scheme == "https" else 80)


def _decoded_url_path(path: str) -> tuple[str, ...] | None:
    if not path.startswith("/"):
        return None
    result = []
    for segment in path.split("/"):
        for index, character in enumerate(segment):
            if character == "%" and (
                index + 2 >= len(segment)
                or segment[index + 1] not in _HEX_DIGITS
                or segment[index + 2] not in _HEX_DIGITS
            ):
                return None
        try:
            decoded = unquote(segment, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return None
        if (
            decoded in {".", ".."}
            or "/" in decoded
            or "\\" in decoded
            or any(ord(character) < 32 or ord(character) == 127 for character in decoded)
        ):
            return None
        result.append(decoded)
    return tuple(result)


def _validated_graph_next_path(base_url: str, collection: str, next_link: object) -> str:
    if not isinstance(next_link, str) or not next_link or any(
        ord(character) < 33 or ord(character) == 127 for character in next_link
    ):
        raise HTTPException(502, "Ungültige OneDrive-Folgeseite.")

    try:
        base = urlsplit(base_url.rstrip("/"))
        candidate = urlsplit(next_link)
    except ValueError as exc:
        raise HTTPException(502, "Ungültige OneDrive-Folgeseite.") from exc
    expected_path = base.path.rstrip("/") + collection
    expected_segments = _decoded_url_path(expected_path)
    candidate_segments = _decoded_url_path(candidate.path)
    base_origin = _url_origin(base)
    if (
        base_origin is None
        or _url_origin(candidate) != base_origin
        or candidate.fragment
        or not candidate.query
        or expected_segments is None
        or candidate_segments != expected_segments
    ):
        raise HTTPException(502, "Ungültige OneDrive-Folgeseite.")

    # Keep the opaque Graph query, but rebuild the path from the trusted
    # collection so equivalent escaping (notably b! versus b%21) cannot alter
    # the drive or folder being queried.
    return f"{collection}?{candidate.query}"


def safe_name(name: str) -> str:
    if (
        not name
        or name in {".", ".."}
        or len(name) > 220
        or any(c in name for c in '/\\\x00\r\n:*?"<>|')
        or any(ord(c) < 32 for c in name)
        or name != name.strip()
        or name.endswith(".")
        or name.startswith(".")
    ):
        raise HTTPException(422, "Ungültiger Dateiname.")
    return name


def conflict() -> HTTPException:
    return HTTPException(
        409, "Der Preisvergleich wurde zwischenzeitlich geändert. Bitte neu laden."
    )


@dataclass(frozen=True)
class StoredFile:
    kind: str
    name: str
    size: int
    modified: str
    version: str
    item_id: str = ""


@dataclass
class Snapshot:
    files: list[StoredFile]
    state: dict
    state_file: StoredFile | None
    revision: str

    def find(self, kind: str, name: str) -> StoredFile:
        safe_name(name)
        matches = [f for f in self.files if f.kind == kind and f.name == name]
        if len(matches) != 1:
            raise HTTPException(404, "Datei im Preisvergleich nicht gefunden.")
        return matches[0]


class LocalPriceStorage:
    mode = "local"
    configured = True

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.identity = str(self.root)

    def _path(self, kind: str, name: str) -> Path:
        if kind not in FOLDERS:
            raise HTTPException(422, "Unbekannte Dateiart.")
        path = self.root / FOLDERS[kind] / safe_name(name)
        if path.parent.is_symlink() or path.is_symlink():
            raise HTTPException(422, "Verknüpfungen sind im Preisvergleich nicht erlaubt.")
        if not path.resolve().is_relative_to(self.root):
            raise HTTPException(422, "Ungültiger Dateipfad.")
        return path

    def list(self, kind: str) -> list[StoredFile]:
        folder = self._path(kind, "placeholder").parent
        if not folder.exists():
            return []
        result = []
        for path in sorted(folder.iterdir()):
            if path.name.startswith("."):
                continue
            if path.is_file() and not path.is_symlink():
                safe_name(path.name)
                stat = path.stat()
                version = f"{stat.st_mtime_ns}:{stat.st_size}:{stat.st_ino}"
                result.append(
                    StoredFile(
                        kind,
                        path.name,
                        stat.st_size,
                        datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
                        version,
                    )
                )
        return result

    def read(self, item: StoredFile) -> bytes:
        path = self._path(item.kind, item.name)
        if not path.is_file():
            raise conflict()
        current = next((f for f in self.list(item.kind) if f.name == item.name), None)
        if not current or current.version != item.version:
            raise conflict()
        if item.size > MAX_FILE_BYTES:
            raise HTTPException(413, "Datei ist größer als 40 MB.")
        content = path.read_bytes()
        after = next((f for f in self.list(item.kind) if f.name == item.name), None)
        if not after or after.version != item.version or len(content) != item.size:
            raise conflict()
        return content

    def write(self, kind: str, name: str, raw: bytes, previous: StoredFile | None) -> StoredFile:
        path = self._path(kind, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        current = next((f for f in self.list(kind) if f.name.casefold() == name.casefold()), None)
        if (current is None) != (previous is None) or (
            current and previous and (current.version != previous.version or current.name != name)
        ):
            raise conflict()
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=".pending-", delete=False
        ) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        return next(f for f in self.list(kind) if f.name == name)

    def delete(self, item: StoredFile) -> None:
        self.read(item)  # Reject stale revisions before touching the file.
        self._path(item.kind, item.name).unlink()

    @contextmanager
    def lock(self, db=None):
        with (self.root / ".calendar.lock").open("a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


class GraphPriceStorage:
    mode = "onedrive"

    def __init__(self, config=settings, project_storage=None):
        self.config = config
        self.configured = bool(
            config.ms_graph_enabled
            and config.ms_project_drive_id
            and config.ms_project_root_folder_id
            and config.ms_tenant_id
            and config.ms_client_id
            and config.ms_client_secret
        )
        self.project_storage = project_storage or get_material_order_storage_service()
        self.graph = self.project_storage.graph_client
        self.identity = f"{config.ms_project_drive_id}:{config.ms_project_root_folder_id}"
        # kind -> (Preisvergleich root id, kind folder id).  IDs remain stable
        # when a folder is moved in OneDrive, so cached IDs must retain their
        # expected ancestry as well as the leaf id.
        self._folder_cache: dict[str, tuple[str, str]] = {}
        self._validated_folder_cache: set[str] = set()

    def _check(self):
        if not self.configured:
            raise HTTPException(
                503, "Die OneDrive-Anbindung des Kalenders ist noch nicht eingerichtet."
            )

    def _collection(self, folder_id):
        return f"/drives/{quote(self.config.ms_project_drive_id, safe='')}/items/{quote(folder_id, safe='')}/children"

    def _children(self, folder_id):
        collection = self._collection(folder_id)
        path = (
            collection
            + "?$select=id,name,size,eTag,lastModifiedDateTime,folder,file,parentReference,remoteItem"
        )
        seen, items = set(), []
        while path:
            if path in seen or len(seen) >= 100:
                raise HTTPException(502, "OneDrive-Dateiliste ist unvollständig.")
            seen.add(path)
            data = self.graph.get(path)
            if not isinstance(data.get("value"), list):
                raise HTTPException(502, "Ungültige Dateiliste von OneDrive.")
            for item in data["value"]:
                if not isinstance(item, dict) or item.get("remoteItem"):
                    continue
                parent = item.get("parentReference", {})
                if (
                    parent.get("id") != folder_id
                    or parent.get("driveId", self.config.ms_project_drive_id)
                    != self.config.ms_project_drive_id
                ):
                    raise HTTPException(
                        502, "OneDrive-Datei liegt außerhalb des erwarteten Ordners."
                    )
                items.append(item)
            next_link = data.get("@odata.nextLink")
            path = (
                _validated_graph_next_path(
                    self.config.ms_graph_base_url,
                    collection,
                    next_link,
                )
                if next_link is not None
                else ""
            )
        return items

    def _child_folder(self, parent_id: str, name: str, create: bool):
        matches = [
            item
            for item in self._children(parent_id)
            if str(item.get("name", "")).casefold() == name.casefold()
        ]
        if len(matches) > 1 or (matches and not isinstance(matches[0].get("folder"), dict)):
            raise HTTPException(409, f"OneDrive-Ordner {name} ist nicht eindeutig.")
        if matches:
            return matches[0]["id"]
        if not create:
            return None
        try:
            created = self.graph.post(
                self._collection(parent_id),
                {
                    "name": name,
                    "folder": {},
                    "@microsoft.graph.conflictBehavior": "fail",
                },
            )
        except MicrosoftGraphRequestError as exc:
            if exc.status_code == 409:
                return self._child_folder(parent_id, name, False)
            raise
        if not created.get("id"):
            raise HTTPException(502, "OneDrive hat keine Ordnerkennung zurückgegeben.")
        return created["id"]

    def _validate_folder(self, folder_id: str, parent_id: str, name: str) -> None:
        metadata = self.graph.get(
            f"/drives/{quote(self.config.ms_project_drive_id, safe='')}/items/"
            f"{quote(folder_id, safe='')}?"
            "$select=id,name,folder,parentReference,remoteItem"
        )
        parent = metadata.get("parentReference", {})
        if (
            metadata.get("id") != folder_id
            or metadata.get("remoteItem")
            or not isinstance(metadata.get("folder"), dict)
            or str(metadata.get("name", "")).casefold() != name.casefold()
            or parent.get("id") != parent_id
            or parent.get("driveId") != self.config.ms_project_drive_id
        ):
            raise conflict()

    def _folder(self, kind: str, create=False):
        self._check()
        if kind not in FOLDERS:
            raise HTTPException(422, "Unbekannte Dateiart.")
        cached = self._folder_cache.get(kind)
        if cached:
            root, folder = cached
            if kind not in self._validated_folder_cache:
                try:
                    # A driveItem id survives moves.  Revalidate both links on
                    # the first reuse after discovery so a folder moved between
                    # snapshot/listing and the request's item operations cannot
                    # turn an item-id read or write into an out-of-root access.
                    # Storage instances are request-scoped; retaining this
                    # validation for the rest of the request avoids two Graph
                    # round trips per PDF during a large initial cache fill.
                    self._validate_folder(
                        root,
                        self.config.ms_project_root_folder_id,
                        FOLDER_NAME,
                    )
                    self._validate_folder(folder, root, FOLDERS[kind])
                except Exception:
                    self._folder_cache.pop(kind, None)
                    self._validated_folder_cache.discard(kind)
                    raise
                self._validated_folder_cache.add(kind)
            return folder
        root = self._child_folder(self.config.ms_project_root_folder_id, FOLDER_NAME, create)
        folder = self._child_folder(root, FOLDERS[kind], create) if root else None
        if root and folder:
            self._folder_cache[kind] = (root, folder)
            self._validated_folder_cache.discard(kind)
        return folder

    def list(self, kind: str) -> list[StoredFile]:
        folder_id = self._folder(kind)
        if not folder_id:
            return []
        return [
            self._file(kind, item)
            for item in self._children(folder_id)
            if isinstance(item.get("file"), dict)
        ]

    def _file(self, kind, item):
        if not item.get("eTag") or not item.get("id"):
            raise HTTPException(502, "OneDrive lieferte keine Dateiversion.")
        return StoredFile(
            kind,
            safe_name(item["name"]),
            int(item.get("size", 0)),
            item.get("lastModifiedDateTime", ""),
            item["eTag"],
            item["id"],
        )

    def _item_path(self, item: StoredFile):
        return f"/drives/{quote(self.config.ms_project_drive_id, safe='')}/items/{quote(item.item_id, safe='')}"

    def _validate_item(self, item):
        metadata = self.graph.get(
            self._item_path(item)
            + "?$select=id,name,size,eTag,lastModifiedDateTime,file,parentReference,remoteItem"
        )
        parent = metadata.get("parentReference", {})
        if (
            metadata.get("remoteItem")
            or not isinstance(metadata.get("file"), dict)
            or parent.get("id") != self._folder(item.kind)
            or parent.get("driveId") != self.config.ms_project_drive_id
        ):
            raise conflict()
        current = self._file(item.kind, metadata)
        if (
            current.item_id != item.item_id
            or current.version != item.version
            or current.name != item.name
        ):
            raise conflict()
        return current

    def read(self, item: StoredFile) -> bytes:
        self._validate_item(item)
        if item.size > MAX_FILE_BYTES:
            raise HTTPException(413, "Datei ist größer als 40 MB.")
        content, _ = self.graph.get_content(self._item_path(item) + "/content")
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(413, "Datei ist größer als 40 MB.")
        self._validate_item(item)
        return content

    def write(self, kind: str, name: str, raw: bytes, previous: StoredFile | None) -> StoredFile:
        safe_name(name)
        folder = self._folder(kind, create=True)
        if previous:
            self._validate_item(previous)
            path = self._item_path(previous) + "/content"
            result = self.graph.put_content(path, raw, if_match=previous.version)
        else:
            path = (
                f"/drives/{quote(self.config.ms_project_drive_id, safe='')}/items/"
                f"{quote(folder, safe='')}:/{quote(name, safe='')}:/content"
                "?@microsoft.graph.conflictBehavior=fail"
            )
            result = self.graph.put_content(path, raw, if_none_match="*")
        return self._file(kind, result)

    def delete(self, item: StoredFile):
        self._validate_item(item)
        self.graph.delete(self._item_path(item), if_match=item.version)

    @contextmanager
    def lock(self, db):
        if db is None:
            raise RuntimeError("Graph mutations require a database session.")
        # Transaction-scoped lock serializes mutations across all API workers.
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
        try:
            yield
        finally:
            db.rollback()  # This dedicated session never stores calendar records.


def get_price_storage(config=settings):
    local_root = config.price_comparison_local_root
    if local_root:
        if os.environ.get("LOCAL_TEST_MODE") != "isolated" or config.environment != "local-test":
            raise HTTPException(
                503, "Lokale Preisdateien sind ausschließlich im isolierten Testkalender erlaubt."
            )
        return LocalPriceStorage(Path(local_root))
    return GraphPriceStorage(config)


def snapshot(store) -> Snapshot:
    files = [
        f
        for kind in ("offers", "datanorm")
        for f in store.list(kind)
        if (kind == "offers" and f.name.lower().endswith(".pdf"))
        or (kind == "datanorm" and f.name.lower().endswith((".txt", ".dat")))
    ]
    cache_files = store.list("cache")
    state_file = next((f for f in cache_files if f.name == STATE_NAME), None)
    state = {
        "version": 1,
        "discounts": {},
        "offer_types": {},
        "align_netto": {},
        "manual_prices": {},
        "reference_presets": {},
        "deleted_articles": {},
        "frozen_metrics": {},
        "active_datanorm": None,
    }
    if state_file:
        try:
            saved = json.loads(store.read(state_file))
            if not isinstance(saved, dict) or saved.get("version") != 1:
                raise ValueError("invalid state")
            state.update(saved)
        except (ValueError, UnicodeError) as exc:
            raise HTTPException(
                422, "Gespeicherte Preisvergleich-Einstellungen sind ungültig."
            ) from exc
    else:
        # Original persistent JSON schemas are read without altering their files.
        for item in cache_files:
            if item.name in LEGACY_SETTINGS:
                try:
                    value = json.loads(store.read(item))
                    if not isinstance(value, dict):
                        raise ValueError("invalid legacy state")
                    state[LEGACY_SETTINGS[item.name]] = value
                except (ValueError, UnicodeError) as exc:
                    raise HTTPException(
                        422, f"Einstellungsdatei {item.name} ist ungültig."
                    ) from exc
        datanorm = sorted(
            (f for f in files if f.kind == "datanorm"),
            key=lambda f: (f.modified, f.name),
            reverse=True,
        )
        if datanorm:
            state["active_datanorm"] = datanorm[0].name
    for key in (
        "discounts",
        "offer_types",
        "align_netto",
        "manual_prices",
        "reference_presets",
        "deleted_articles",
        "frozen_metrics",
    ):
        if not isinstance(state.get(key), dict):
            raise HTTPException(422, "Gespeicherte Preisvergleich-Einstellungen sind ungültig.")
    identities = [
        (f.kind, f.name, f.version)
        for f in files + cache_files
        if f.kind != "cache" or f.name == STATE_NAME or f.name in LEGACY_SETTINGS
    ]
    revision = hashlib.sha256(
        json.dumps(sorted(identities), ensure_ascii=False).encode()
    ).hexdigest()
    return Snapshot(files, state, state_file, revision)


def require_revision(snap: Snapshot, expected: str):
    if not expected or snap.revision != expected:
        raise conflict()


def save_state(store, snap: Snapshot):
    data = json.dumps(snap.state, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    store.write("cache", STATE_NAME, data, snap.state_file)


@contextmanager
def graph_errors():
    try:
        yield
    except MicrosoftGraphRequestError as exc:
        if exc.status_code in (409, 412):
            raise conflict() from exc
        if exc.status_code == 404:
            raise HTTPException(
                409,
                "Eine Preisvergleich-Datei wurde extern verschoben oder gelöscht. Bitte neu laden.",
            ) from exc
        raise HTTPException(
            503, "OneDrive ist momentan nicht erreichbar. Bitte erneut versuchen."
        ) from exc
