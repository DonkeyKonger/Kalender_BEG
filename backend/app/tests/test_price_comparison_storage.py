from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from app.services.price_comparison_storage import (
    GraphPriceStorage,
    LocalPriceStorage,
    STATE_NAME,
    get_price_storage,
    require_revision,
    safe_name,
    save_state,
    snapshot,
)


@pytest.mark.parametrize(
    "name",
    [
        "../secret",
        "sub/a.pdf",
        "..",
        ".hidden",
        "a\\b",
        "a\n.pdf",
        "a\x00.pdf",
        "a:",
        " a.pdf",
        "a.pdf.",
        "a?b.pdf",
    ],
)
def test_rejects_filename_escape(name):
    with pytest.raises(HTTPException) as error:
        safe_name(name)
    assert error.value.status_code == 422


def test_local_storage_roundtrip_preserves_raw_bytes_and_checks_versions(tmp_path):
    store = LocalPriceStorage(tmp_path)
    before = snapshot(store)
    original = b"%PDF-1.7\r\n\x00\xff unchanged bytes"
    with store.lock():
        item = store.write("offers", "Angebot ä.pdf", original, None)
    assert store.read(item) == original
    after = snapshot(store)
    assert before.revision != after.revision
    with pytest.raises(HTTPException) as error:
        require_revision(after, before.revision)
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        store.write("offers", item.name, b"replacement", None)
    updated = store.write("offers", item.name, b"replacement", item)
    with pytest.raises(HTTPException):
        store.delete(item)
    assert store.read(updated) == b"replacement"


def test_legacy_settings_read_without_changing_original_files(tmp_path):
    store = LocalPriceStorage(tmp_path)
    legacy = b'{"one.pdf": 12.5}'
    store.write("cache", "rabatte.json", legacy, None)
    store.write("datanorm", "aktuell.dat", b"A;", None)
    snap = snapshot(store)
    assert snap.state["discounts"] == {"one.pdf": 12.5}
    assert snap.state["active_datanorm"] == "aktuell.dat"
    snap.state["manual_prices"]["one.pdf||6047611"] = 7.25
    save_state(store, snap)
    saved = snapshot(store)
    assert saved.state["manual_prices"]["one.pdf||6047611"] == 7.25
    assert (tmp_path / "cache" / "rabatte.json").read_bytes() == legacy
    with pytest.raises(HTTPException):
        save_state(store, snap)


def test_corrupt_shared_state_is_not_silently_replaced(tmp_path):
    store = LocalPriceStorage(tmp_path)
    store.write("cache", STATE_NAME, b"broken", None)
    with pytest.raises(HTTPException) as error:
        snapshot(store)
    assert error.value.status_code == 422
    assert (tmp_path / "cache" / STATE_NAME).read_bytes() == b"broken"


def test_symlink_folder_cannot_read_outside_root(tmp_path):
    root = tmp_path / "root"
    store = LocalPriceStorage(root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"secret")
    (root / "angebote").symlink_to(outside, target_is_directory=True)
    with pytest.raises(HTTPException):
        store.list("offers")


def test_local_storage_is_only_available_in_isolated_test_mode(tmp_path, monkeypatch):
    config = SimpleNamespace(price_comparison_local_root=str(tmp_path), environment="production")
    monkeypatch.setenv("LOCAL_TEST_MODE", "isolated")
    with pytest.raises(HTTPException):
        get_price_storage(config)
    config.environment = "local-test"
    monkeypatch.delenv("LOCAL_TEST_MODE")
    with pytest.raises(HTTPException):
        get_price_storage(config)
    monkeypatch.setenv("LOCAL_TEST_MODE", "isolated")
    assert isinstance(get_price_storage(config), LocalPriceStorage)


class FakeGraph:
    def __init__(self):
        self.calls = []
        self.children = {"calendar-root": []}

    def get(self, path):
        self.calls.append(("GET", path))
        item_path = path.split("/items/", 1)[1]
        item_id = item_path.split("/", 1)[0].split("?", 1)[0]
        if "/children" in item_path:
            return {"value": self.children.get(item_id, [])}
        for children in self.children.values():
            for item in children:
                if item.get("id") == item_id:
                    return dict(item)
        return {}

    def post(self, path, payload):
        self.calls.append(("POST", path, payload))
        parent = path.split("/items/")[1].split("/")[0]
        item = {
            "id": "id-" + payload["name"],
            "name": payload["name"],
            "folder": {},
            "parentReference": {"id": parent, "driveId": "drive"},
        }
        self.children.setdefault(parent, []).append(item)
        self.children[item["id"]] = []
        return item


def graph_store(graph, *, drive_id="drive"):
    config = SimpleNamespace(
        ms_graph_enabled=True,
        ms_project_drive_id=drive_id,
        ms_project_root_folder_id="calendar-root",
        ms_tenant_id="tenant",
        ms_client_id="client",
        ms_client_secret="test-only",
        ms_graph_base_url="https://graph.microsoft.com/v1.0",
    )
    return GraphPriceStorage(config, SimpleNamespace(graph_client=graph))


def test_graph_folder_is_direct_root_child_and_read_does_not_create():
    graph = FakeGraph()
    store = graph_store(graph)
    assert store.list("offers") == []
    assert not any(call[0] == "POST" for call in graph.calls)
    assert store._folder("offers", create=True) == "id-angebote"
    created = [call for call in graph.calls if call[0] == "POST"]
    assert created[0][1] == "/drives/drive/items/calendar-root/children"
    assert created[0][2]["name"] == "Preisvergleich"
    assert created[1][1] == "/drives/drive/items/id-Preisvergleich/children"
    assert created[1][2]["@microsoft.graph.conflictBehavior"] == "fail"


def test_graph_rejects_remote_shortcut_and_wrong_parent():
    graph = FakeGraph()
    graph.children["calendar-root"] = [
        {
            "id": "outside",
            "name": "Preisvergleich",
            "folder": {},
            "parentReference": {"id": "different-root", "driveId": "drive"},
        }
    ]
    with pytest.raises(HTTPException) as error:
        graph_store(graph).list("offers")
    assert error.value.status_code == 502


@pytest.mark.parametrize(
    "next_link",
    [
        "https://evil.example/v1.0/drives/drive/items/folder/children?$skiptoken=next",
        "https://graph.microsoft.com.evil.example/v1.0/drives/drive/items/folder/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/other/items/folder/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/drive/items/other/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/drive/items/folder/../other/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/drive/items/%2e%2e/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/drive/items/folder%2F..%2Fother/children?$skiptoken=next",
        "https://graph.microsoft.com/v1.0/drives/drive/items/folder/children/extra?$skiptoken=next",
        "https://[graph.microsoft.com/v1.0/drives/drive/items/folder/children?$skiptoken=next",
    ],
)
def test_graph_rejects_pagination_outside_collection(next_link):
    graph = FakeGraph()
    graph.get = lambda path: {"value": [], "@odata.nextLink": next_link}
    with pytest.raises(HTTPException) as error:
        graph_store(graph)._children("folder")
    assert error.value.status_code == 502


@pytest.mark.parametrize("next_drive_id", ["b!price-drive", "b%21price-drive"])
def test_graph_accepts_encoded_or_unencoded_drive_id_in_same_collection_next_link(
    next_drive_id,
):
    graph = FakeGraph()
    calls = []
    responses = iter(
        [
            {
                "value": [],
                "@odata.nextLink": (
                    "https://graph.microsoft.com/v1.0/drives/"
                    f"{next_drive_id}/items/folder/children"
                    "?$select=id,name&$skiptoken=opaque-next-page"
                ),
            },
            {"value": []},
        ]
    )

    def get(path):
        calls.append(path)
        return next(responses)

    graph.get = get

    assert graph_store(graph, drive_id="b!price-drive")._children("folder") == []
    assert calls == [
        "/drives/b%21price-drive/items/folder/children"
        "?$select=id,name,size,eTag,lastModifiedDateTime,folder,file,parentReference,remoteItem",
        "/drives/b%21price-drive/items/folder/children"
        "?$select=id,name&$skiptoken=opaque-next-page",
    ]


def test_graph_ambiguous_root_fails_closed():
    graph = FakeGraph()
    graph.children["calendar-root"] = [
        {
            "id": str(i),
            "name": "Preisvergleich",
            "folder": {},
            "parentReference": {"id": "calendar-root", "driveId": "drive"},
        }
        for i in range(2)
    ]
    with pytest.raises(HTTPException) as error:
        graph_store(graph).list("offers")
    assert error.value.status_code == 409


@pytest.mark.parametrize("moved_folder", ["root", "leaf"])
def test_graph_revalidates_cached_folder_ancestry_before_item_operations(moved_folder):
    graph = FakeGraph()
    store = graph_store(graph)
    assert store._folder("offers", create=True) == "id-angebote"

    root = next(
        item for item in graph.children["calendar-root"] if item["id"] == "id-Preisvergleich"
    )
    leaf = next(item for item in graph.children["id-Preisvergleich"] if item["id"] == "id-angebote")
    target = root if moved_folder == "root" else leaf
    target["parentReference"]["id"] = "externally-moved"

    with pytest.raises(HTTPException) as error:
        store.list("offers")
    assert error.value.status_code == 409
