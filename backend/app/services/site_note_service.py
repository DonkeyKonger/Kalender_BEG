from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.site import Site
from app.models.site_note import SiteInternalNote, SiteNoteBlock
from app.schemas.site_note import SiteInternalNoteUpdate, SiteNoteBlockRead, SiteNoteBlockUpdate, SiteNotesRead
from app.services.audit_service import AuditService
from app.services.site_service import SiteService


class SiteNoteService:
    def __init__(self, db: Session):
        self.db = db

    def read(self, site_id: int) -> SiteNotesRead:
        SiteService(self.db).get_site(site_id)
        internal = self.db.get(SiteInternalNote, site_id)
        blocks = self.db.scalars(select(SiteNoteBlock).where(
            SiteNoteBlock.site_id == site_id,
        ).order_by(SiteNoteBlock.number.desc()))
        return SiteNotesRead(
            internal_notes=internal.content if internal else "",
            internal_revision=internal.revision if internal else 0,
            blocks=[SiteNoteBlockRead.model_validate(block) for block in blocks],
        )

    def _lock_site(self, site_id: int):
        SiteService(self.db).get_site(site_id)
        self.db.execute(select(Site.id).where(Site.id == site_id).with_for_update())

    def _check_revision(self, actual: int, expected: int):
        if actual != expected:
            raise HTTPException(409, "Diese Notiz wurde inzwischen geändert. Bitte neu laden und die Änderungen abgleichen.")

    def _audit(self, site_id: int, user_id: int, action: str, revision: int):
        AuditService(self.db).record(
            user_id=user_id, action=action, entity_type="site", entity_id=site_id,
            old_value=None, new_value={"revision": revision},
        )

    def update_internal(self, site_id: int, payload: SiteInternalNoteUpdate, user_id: int) -> SiteNotesRead:
        self._lock_site(site_id)
        note = self.db.get(SiteInternalNote, site_id, populate_existing=True)
        self._check_revision(note.revision if note else 0, payload.expected_revision)
        if note is None:
            note = SiteInternalNote(site_id=site_id, revision=0)
            self.db.add(note)
        note.content = payload.content.strip()
        note.revision += 1
        self._audit(site_id, user_id, "site.internal_notes.updated", note.revision)
        self.db.commit()
        return self.read(site_id)

    def create_block(self, site_id: int, user_id: int) -> SiteNoteBlockRead:
        self._lock_site(site_id)
        number = (self.db.scalar(select(func.max(SiteNoteBlock.number)).where(
            SiteNoteBlock.site_id == site_id,
        )) or 0) + 1
        block = SiteNoteBlock(site_id=site_id, number=number, title=f"Monteurhinweis {number}", content="")
        self.db.add(block)
        self.db.flush()
        self._audit(site_id, user_id, "site.note_block.created", block.revision)
        self.db.commit()
        self.db.refresh(block)
        return SiteNoteBlockRead.model_validate(block)

    def update_block(self, site_id: int, block_id: int, payload: SiteNoteBlockUpdate, user_id: int) -> SiteNoteBlockRead:
        self._lock_site(site_id)
        block = self.db.scalar(select(SiteNoteBlock).where(
            SiteNoteBlock.id == block_id, SiteNoteBlock.site_id == site_id,
        ).execution_options(populate_existing=True))
        if block is None:
            raise HTTPException(404, "Notizblock nicht gefunden.")
        self._check_revision(block.revision, payload.expected_revision)
        title, content = payload.title.strip(), payload.content.strip()
        if not title:
            raise HTTPException(422, "Bitte einen Titel für den Notizblock angeben.")
        if payload.visible_to_workers and not content:
            raise HTTPException(422, "Vor der Freigabe bitte eine Notiz eintragen.")
        block.title, block.content = title, content
        block.visible_to_workers = payload.visible_to_workers
        block.revision += 1
        self._audit(site_id, user_id, "site.note_block.updated", block.revision)
        self.db.commit()
        self.db.refresh(block)
        return SiteNoteBlockRead.model_validate(block)
