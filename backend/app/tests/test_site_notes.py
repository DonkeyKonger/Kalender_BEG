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


def test_new_blocks_are_numbered_and_private_and_empty_blocks_cannot_be_published(notes_case):
    c = notes_case
    first = c.service.create_block(c.site.id, c.user.id)
    second = c.service.create_block(c.site.id, c.user.id)
    assert [first.number, second.number] == [1, 2]
    assert [first.title, second.title] == ["Monteurhinweis 1", "Monteurhinweis 2"]
    assert not first.visible_to_workers and not second.visible_to_workers
    with pytest.raises(HTTPException) as caught:
        c.service.update_block(c.site.id, first.id, update(first, content="  "), c.user.id)
    assert caught.value.status_code == 422
    c.db.rollback()
    assert not c.service.read(c.site.id).blocks[-1].visible_to_workers


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
        block_id = created.json()["id"] if allowed else 123
        responses.append(client.patch(root + f"/blocks/{block_id}", json={
            "title": "Freigabe", "content": "Sichtbar", "visible_to_workers": True, "expected_revision": 1,
        }))
        assert [response.status_code for response in responses] == ([200, 200, 201, 200] if allowed else [403] * 4)
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
    ("Notizstand 1", "Monteurhinweis 1"),
    ("Monteurhinweis 1", "Monteurhinweis 1"),
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
