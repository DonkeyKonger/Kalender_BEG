from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole
from app.models.site import Site
from app.schemas.site import SiteRead
from app.schemas.site_note import MobileSiteNote, SiteInternalNoteUpdate, SiteNoteBlockRead, SiteNoteBlockUpdate
from app.services.mobile_assignment_service import MobileAssignmentService
from app.services.site_note_service import SiteNoteService
from app.tests.test_mobile_assignment_service import history_context, add_history_assignment


@pytest.fixture
def notes_case():
    db, user, worker, _ = history_context()
    assignment = add_history_assignment(db, person=worker, site_number="NOTES", work_date=date(2026, 9, 8))
    assignment.site.info = "Allgemeine Notiz für Matrix und Monteure"
    db.commit()
    yield SimpleNamespace(db=db, user=user, worker=worker, assignment=assignment, site=assignment.site, service=SiteNoteService(db))
    db.close()


def update(block, *, content="Aktueller Projektstand", visible=True):
    return SiteNoteBlockUpdate(title=block.title, content=content, visible_to_workers=visible, expected_revision=block.revision)


def test_private_notes_and_hidden_history_never_enter_mobile_or_general_site_payload(notes_case):
    c = notes_case
    c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="VERTRAULICH Büro", expected_revision=0), c.user.id)
    old = c.service.create_block(c.site.id, c.user.id)
    old = c.service.update_block(c.site.id, old.id, update(old, content="ALTER INTERNER STAND", visible=False), c.user.id)
    current = c.service.create_block(c.site.id, c.user.id)
    current = c.service.update_block(c.site.id, current.id, update(current), c.user.id)
    mobile = MobileAssignmentService(c.db).list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8))
    payload = mobile.model_dump_json()
    assert "VERTRAULICH" not in payload
    assert "ALTER INTERNER STAND" not in payload
    assert "Allgemeine Notiz" in payload
    assert [note.id for note in mobile.assignments[0].site.note_blocks] == [current.id]
    general_site = SiteRead.model_validate(c.site).model_dump_json()
    assert "VERTRAULICH" not in general_site
    assert "ALTER INTERNER STAND" not in general_site
    assert c.site.info == "Allgemeine Notiz für Matrix und Monteure"
    # Switching visibility never deletes historical text; multiple blocks may be shown.
    c.service.update_block(c.site.id, old.id, update(old, content=old.content, visible=True), c.user.id)
    mobile = MobileAssignmentService(c.db).list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8))
    assert len(mobile.assignments[0].site.note_blocks) == 2
    c.service.update_block(c.site.id, current.id, update(current, visible=False), c.user.id)
    mobile = MobileAssignmentService(c.db).list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8))
    assert [note.id for note in mobile.assignments[0].site.note_blocks] == [old.id]
    assert len(c.service.read(c.site.id).blocks) == 2


def test_new_blocks_are_numbered_and_visible_by_default_and_can_be_hidden(notes_case):
    c = notes_case
    first = c.service.create_block(c.site.id, c.user.id)
    second = c.service.create_block(c.site.id, c.user.id)
    assert [first.number, second.number] == [1, 2]
    assert [first.title, second.title] == ["1. Monteurinfo", "2. Monteurinfo"]
    assert first.visible_to_workers and second.visible_to_workers
    first = c.service.update_block(c.site.id, first.id, update(first, content="", visible=False), c.user.id)
    third = c.service.create_block(c.site.id, c.user.id)
    persisted = {block.id: block for block in c.service.read(c.site.id).blocks}
    assert not persisted[first.id].visible_to_workers
    assert persisted[second.id].visible_to_workers and persisted[third.id].visible_to_workers
    # The checkbox remains freely changeable before entering text.
    first = c.service.update_block(c.site.id, first.id, update(first, content="  ", visible=True), c.user.id)
    assert first.visible_to_workers and first.content == ""


def test_default_visible_notes_reach_mobile_after_text_is_saved_and_can_be_cleared(notes_case):
    c = notes_case
    mobile = MobileAssignmentService(c.db)
    block = c.service.create_block(c.site.id, c.user.id)
    def mobile_site():
        return mobile.list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8)).assignments[0].site
    assert mobile_site().note_blocks == []
    assert mobile_site().info == c.site.info
    assert mobile.project_notes(c.assignment.id, c.user).note_blocks == []
    block = c.service.update_block(c.site.id, block.id, update(block, content="Sofort für Monteure sichtbar"), c.user.id)
    assert "Sofort für Monteure sichtbar" in mobile_site().info
    assert [note.id for note in mobile.project_notes(c.assignment.id, c.user).note_blocks] == [block.id]
    block = c.service.update_block(c.site.id, block.id, update(block, content="  "), c.user.id)
    assert block.visible_to_workers and block.content == ""
    assert mobile_site().info == c.site.info
    assert mobile.project_notes(c.assignment.id, c.user).note_blocks == []
    block = c.service.update_block(c.site.id, block.id, update(block, content="Neuer Text"), c.user.id)
    assert "Neuer Text" in mobile_site().info
    block = c.service.update_block(c.site.id, block.id, update(block, content=block.content, visible=False), c.user.id)
    assert mobile_site().info == c.site.info
    assert mobile.project_notes(c.assignment.id, c.user).note_blocks == []
    assert c.service.read(c.site.id).blocks[0].content == "Neuer Text"


def test_stale_updates_preserve_both_internal_notes_and_published_block(notes_case):
    c = notes_case
    internal = SiteInternalNoteUpdate(content="Erster Stand", expected_revision=0)
    c.service.update_internal(c.site.id, internal, c.user.id)
    with pytest.raises(HTTPException) as caught:
        c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="Veraltet", expected_revision=0), c.user.id)
    assert caught.value.status_code == 409
    c.db.rollback()
    assert c.service.read(c.site.id).internal_notes == "Erster Stand"
    block = c.service.create_block(c.site.id, c.user.id)
    c.service.update_block(c.site.id, block.id, update(block), c.user.id)
    with pytest.raises(HTTPException) as caught:
        c.service.update_block(c.site.id, block.id, update(block, content="Veraltet", visible=False), c.user.id)
    assert caught.value.status_code == 409
    c.db.rollback()
    assert c.service.read(c.site.id).blocks[0].content == "Aktueller Projektstand"
    assert c.service.read(c.site.id).blocks[0].visible_to_workers


def test_block_cannot_be_updated_through_another_site(notes_case):
    c = notes_case
    other = Site(name="Andere Baustelle")
    c.db.add(other)
    c.db.commit()
    block = c.service.create_block(c.site.id, c.user.id)
    with pytest.raises(HTTPException) as caught:
        c.service.update_block(other.id, block.id, update(block), c.user.id)
    assert caught.value.status_code == 404


@pytest.mark.parametrize("role,permissions,allowed", [
    (UserRole.MONTEUR, ["sites"], False),
    (UserRole.OFFICE, [], False),
    (UserRole.OFFICE, ["calendar"], False),
    (UserRole.OFFICE, ["sites"], True),
    (UserRole.PROJECT_MANAGER, [], True),
    (UserRole.ADMIN, [], True),
])
def test_office_note_api_protects_all_read_and_write_routes(notes_case, role, permissions, allowed):
    c = notes_case
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=c.user.id, role=role, office_page_permissions=permissions,
        is_active=True, must_change_password=False,
    )
    app.dependency_overrides[get_db] = lambda: c.db
    client = TestClient(app)
    root = f"/api/sites/{c.site.id}/notes"
    try:
        responses = [client.get(root), client.patch(root + "/internal", json={"content": "Intern", "expected_revision": 0})]
        created = client.post(root + "/blocks")
        responses.append(created)
        if allowed:
            assert created.json()["visible_to_workers"] is True
        block_id = created.json()["id"] if allowed else 123
        responses.append(client.patch(root + f"/blocks/{block_id}", json={
            "title": "Freigabe", "content": "Sichtbar", "visible_to_workers": True, "expected_revision": 1,
        }))
        responses.append(client.delete(root + f"/blocks/{block_id}?expected_revision=2"))
        assert [response.status_code for response in responses] == ([200, 200, 201, 200, 204] if allowed else [403] * 5)
    finally:
        app.dependency_overrides.clear()


def test_mobile_notes_are_loaded_in_one_batch_for_multiple_sites(notes_case):
    c = notes_case
    for number in range(3):
        add_history_assignment(c.db, person=c.worker, site_number=f"BATCH-{number}", work_date=date(2026, 9, 8))
    queries = []
    def capture(_connection, _cursor, statement, _parameters, _context, _executemany):
        if "FROM site_note_blocks" in statement or "JOIN site_note_blocks" in statement:
            queries.append(statement)
    event.listen(c.db.bind, "before_cursor_execute", capture)
    try:
        mobile = MobileAssignmentService(c.db).list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8))
        assert len(mobile.assignments) == 4
        assert len(queries) == 1
    finally:
        event.remove(c.db.bind, "before_cursor_execute", capture)


def test_mobile_live_notes_are_assignment_scoped_and_refresh_visibility(notes_case):
    c = notes_case
    block = c.service.create_block(c.site.id, c.user.id)
    published = c.service.update_block(c.site.id, block.id, update(block), c.user.id)
    mobile = MobileAssignmentService(c.db)
    assert len(mobile.project_notes(c.assignment.id, c.user).note_blocks) == 1
    c.service.update_block(c.site.id, published.id, update(published, visible=False), c.user.id)
    assert mobile.project_notes(c.assignment.id, c.user).note_blocks == []
    with pytest.raises(HTTPException) as caught:
        mobile.project_notes(c.assignment.id, SimpleNamespace(person_id=c.worker.id + 100))
    assert caught.value.status_code == 404
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: c.user
    app.dependency_overrides[get_db] = lambda: c.db
    try:
        response = TestClient(app).get(f"/api/me/assignments/{c.assignment.id}/project-notes")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"info": c.site.info, "note_blocks": []}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("schema", [SiteNoteBlockRead, MobileSiteNote])
@pytest.mark.parametrize("title, expected", [
    ("Notizstand 1", "1. Monteurinfo"),
    ("Monteurhinweis 1", "1. Monteurinfo"),
    ("1. Monteurinfo", "1. Monteurinfo"),
    ("Monteurhinweis 2", "Monteurhinweis 2"),
    ("Dacharbeiten September", "Dacharbeiten September"),
    ("Notizstand 2", "Notizstand 2"),
])
def test_note_title_display_renames_only_matching_generated_titles(schema, title, expected):
    payload = dict(id=1, number=1, title=title, content="Bestehender Text", visible_to_workers=True,
                   revision=3, created_at="2026-09-08T10:00:00Z", updated_at="2026-09-08T10:00:00Z")
    result = schema.model_validate(payload)
    assert result.title == expected
    assert result.content == payload["content"]
    assert payload["title"] == title


@pytest.mark.parametrize("general", [None, "", "Allgemeine Notiz\nmit zweiter Zeile"])
def test_legacy_mobile_info_contains_only_published_hints_and_preserves_general_notes(notes_case, general):
    from datetime import datetime, timezone
    from app.models.site_note import SiteNoteBlock

    c = notes_case
    c.site.info = general
    c.db.commit()
    c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="GEHEIM BÜRO", expected_revision=0), c.user.id)
    mobile = MobileAssignmentService(c.db)
    def load():
        return mobile.list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8)).assignments[0].site
    assert load().info == general
    hidden = c.service.create_block(c.site.id, c.user.id)
    c.service.update_block(c.site.id, hidden.id, update(hidden, content="GEHEIM ENTWURF", visible=False), c.user.id)
    first = c.service.create_block(c.site.id, c.user.id)
    first = c.service.update_block(c.site.id, first.id, update(first, content="Zugang über Tor 2.\nSchlüssel im Büro."), c.user.id)
    second = c.service.create_block(c.site.id, c.user.id)
    second = c.service.update_block(c.site.id, second.id, update(second, content="Ab Mittwoch Dacharbeiten."), c.user.id)
    for note in (first, second):
        c.db.get(SiteNoteBlock, note.id).updated_at = datetime(2026, 9, 8, 22, 30, tzinfo=timezone.utc)
    c.db.commit()
    result = load()
    sections = ([general] if general else []) + [
        "[3. Monteurinfo · 09.09.2026]\nAb Mittwoch Dacharbeiten.",
        "[2. Monteurinfo · 09.09.2026]\nZugang über Tor 2.\nSchlüssel im Büro.",
    ]
    # This string is the entire notes UI understood by old installed apps.
    assert result.info == "\n\n".join(sections)
    assert result.general_info == general
    assert "GEHEIM" not in result.model_dump_json()
    assert c.site.info == general
    assert SiteRead.model_validate(c.site).info == general
    live = mobile.project_notes(c.assignment.id, c.user)
    assert live.info == general  # New clients keep separate cards, without duplicates.
    assert [n.id for n in live.note_blocks] == [second.id, first.id]
    c.service.update_block(c.site.id, second.id, update(second, visible=False), c.user.id)
    assert "Ab Mittwoch Dacharbeiten." not in load().info
    c.service.update_block(c.site.id, first.id, update(first, visible=False), c.user.id)
    assert load().info == general
    assert len(c.service.read(c.site.id).blocks) == 3


@pytest.mark.parametrize("path", [
    "/assignments?start=2026-09-08&end=2026-09-08",
    "/assignments/history?start=2026-09-08&end=2026-09-08",
    "/sites",
])
def test_existing_mobile_endpoints_supply_legacy_note_text_without_client_opt_in(notes_case, path):
    c = notes_case
    block = c.service.create_block(c.site.id, c.user.id)
    c.service.update_block(c.site.id, block.id, update(block, content="Alt-App: Eingang im Hof."), c.user.id)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: c.user
    app.dependency_overrides[get_db] = lambda: c.db
    try:
        response = TestClient(app).get("/api/me" + path)
        assert response.status_code == 200
        data = response.json()
        site = data[0] if isinstance(data, list) else data["assignments"][0]["site"]
        assert "Alt-App: Eingang im Hof." in site["info"]
        assert "1. Monteurinfo" in site["info"]
        assert site["general_info"] == c.site.info
    finally:
        app.dependency_overrides.clear()


def test_delete_block_permanently_removes_it_from_storage_and_mobile(notes_case):
    from app.models.site_note import SiteNoteBlock

    c = notes_case
    block = c.service.create_block(c.site.id, c.user.id)
    block = c.service.update_block(c.site.id, block.id, update(block, content="Zu löschender Hinweis"), c.user.id)
    kept = c.service.create_block(c.site.id, c.user.id)
    c.service.delete_block(c.site.id, block.id, block.revision, c.user.id)
    assert c.db.get(SiteNoteBlock, block.id) is None
    assert [b.id for b in c.service.read(c.site.id).blocks] == [kept.id]
    mobile = MobileAssignmentService(c.db)
    assert mobile.project_notes(c.assignment.id, c.user).note_blocks == []
    result = mobile.list_own_assignments(current_user=c.user, start=date(2026, 9, 8), end=date(2026, 9, 8))
    assert "Zu löschender Hinweis" not in result.model_dump_json()
    # A delayed autosave from another client cannot recreate the deleted row.
    with pytest.raises(HTTPException) as caught:
        c.service.update_block(c.site.id, block.id, update(block), c.user.id)
    assert caught.value.status_code == 404


def test_delete_block_rejects_stale_revision_and_wrong_site(notes_case):
    c = notes_case
    block = c.service.create_block(c.site.id, c.user.id)
    current = c.service.update_block(c.site.id, block.id, update(block, content="Neuer Stand"), c.user.id)
    with pytest.raises(HTTPException) as stale:
        c.service.delete_block(c.site.id, block.id, block.revision, c.user.id)
    assert stale.value.status_code == 409
    c.db.rollback()
    other = Site(name="Andere Baustelle")
    c.db.add(other)
    c.db.commit()
    with pytest.raises(HTTPException) as wrong_site:
        c.service.delete_block(other.id, block.id, current.revision, c.user.id)
    assert wrong_site.value.status_code == 404
    c.db.rollback()
    assert c.service.read(c.site.id).blocks[0].content == "Neuer Stand"


def test_clear_internal_notes_retains_revision_without_archiving_content(notes_case):
    c = notes_case
    first = c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="Interne Notiz", expected_revision=0), c.user.id)
    cleared = c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="", expected_revision=first.internal_revision), c.user.id)
    assert cleared.internal_notes == ""
    assert cleared.internal_revision == first.internal_revision + 1
    with pytest.raises(HTTPException) as stale:
        c.service.update_internal(c.site.id, SiteInternalNoteUpdate(content="Interne Notiz", expected_revision=first.internal_revision), c.user.id)
    assert stale.value.status_code == 409


def test_visible_hint_limit_counts_empty_notes_and_is_scoped_to_project(notes_case):
    c = notes_case
    blocks = [c.service.create_block(c.site.id, c.user.id) for _ in range(3)]
    with pytest.raises(HTTPException) as caught:
        c.service.create_block(c.site.id, c.user.id)
    assert caught.value.status_code == 409
    assert "höchstens 3" in caught.value.detail
    c.db.rollback()
    assert len(c.service.read(c.site.id).blocks) == 3
    other = Site(name="Weiteres Projekt")
    c.db.add(other)
    c.db.commit()
    assert c.service.create_block(other.id, c.user.id).visible_to_workers
    edited = c.service.update_block(c.site.id, blocks[0].id, update(blocks[0], content="Neuer Text"), c.user.id)
    assert edited.content == "Neuer Text"
    hidden = c.service.update_block(c.site.id, edited.id, update(edited, visible=False), c.user.id)
    replacement = c.service.create_block(c.site.id, c.user.id)
    assert replacement.visible_to_workers
    with pytest.raises(HTTPException) as caught:
        c.service.update_block(c.site.id, hidden.id, update(hidden, content="Nicht übernehmen"), c.user.id)
    assert caught.value.status_code == 409
    c.db.rollback()
    persisted = next(b for b in c.service.read(c.site.id).blocks if b.id == hidden.id)
    assert not persisted.visible_to_workers
    assert persisted.content == hidden.content
    assert persisted.revision == hidden.revision
    c.service.delete_block(c.site.id, replacement.id, replacement.revision, c.user.id)
    assert c.service.update_block(c.site.id, hidden.id, update(hidden), c.user.id).visible_to_workers


def test_existing_over_capacity_hints_can_be_edited_and_hidden_without_data_loss(notes_case):
    from app.models.site_note import SiteNoteBlock
    c = notes_case
    for n in range(4):
        c.db.add(SiteNoteBlock(site_id=c.site.id, number=n + 1, title=f"Monteurhinweis {n + 1}", content="Bestand", visible_to_workers=True))
    c.db.commit()
    blocks = c.service.read(c.site.id).blocks
    edited = c.service.update_block(c.site.id, blocks[0].id, update(blocks[0]), c.user.id)
    assert edited.visible_to_workers
    hidden = c.service.update_block(c.site.id, edited.id, update(edited, visible=False), c.user.id)
    assert not hidden.visible_to_workers
    with pytest.raises(HTTPException):
        c.service.update_block(c.site.id, hidden.id, update(hidden), c.user.id)
    c.db.rollback()
    assert len(c.service.read(c.site.id).blocks) == 4
