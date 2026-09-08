import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FileText, LockKeyhole, Plus } from "lucide-react";

import { ProjectNoteDeleteButton } from "./ProjectNoteDeleteButton";
import { ProjectNoteTextarea } from "./ProjectNoteTextarea";

import { api } from "../lib/api";
import type { SiteNoteBlock, SiteNotes } from "../types/site";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Die Notiz konnte nicht gespeichert werden. Bitte erneut versuchen.";
}

export function SiteProjectNotes({ siteId, canEdit, children, information }: {
  siteId: number;
  canEdit: boolean;
  children: ReactNode;
  information: ReactNode;
}) {
  const [notes, setNotes] = useState<SiteNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdBlockId, setCreatedBlockId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    api.siteNotes(siteId).then((value) => {
      if (active) { setNotes(value); setError(null); }
    }).catch((reason) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [siteId, canEdit, reload]);

  const updateSavedBlock = useCallback((block: SiteNoteBlock) => {
    setNotes((current) => current ? {
      ...current,
      blocks: current.blocks.map((existing) => existing.id === block.id ? block : existing),
    } : current);
  }, []);
  const removeDeletedBlock = useCallback((blockId: number) => {
    setNotes((current) => current ? { ...current, blocks: current.blocks.filter((block) => block.id !== blockId) } : current);
  }, []);
  const orderedBlocks = [...(notes?.blocks ?? [])].sort((a, b) =>
    Number(b.visible_to_workers) - Number(a.visible_to_workers) || b.number - a.number
  );

  const visibleCount = orderedBlocks.filter((block) => block.visible_to_workers).length;
  const atVisibleLimit = visibleCount >= 3;
  const activeSlots = visibleCount + (atVisibleLimit ? 0 : 1);
  const noteItems = [
    ...orderedBlocks.slice(0, visibleCount),
    ...(!atVisibleLimit ? [null] : []),
    ...orderedBlocks.slice(visibleCount),
  ];
  function placement(index: number, isCreate = false): CSSProperties {
    const position = (columns: number) => {
      const cell = isCreate ? visibleCount : index < visibleCount ? index
        : Math.max(columns, Math.ceil(activeSlots / columns) * columns) + index - visibleCount;
      return [Math.floor(cell / columns) + 1, cell % columns + 1];
    };
    const [row, column] = position(3);
    const [mediumRow, mediumColumn] = position(2);
    const [narrowRow] = position(1);
    return {
      "--note-row": row, "--note-column": column,
      "--note-row-medium": mediumRow, "--note-column-medium": mediumColumn,
      "--note-row-narrow": narrowRow,
    } as CSSProperties;
  }

  async function createBlock() {
    if (creating || atVisibleLimit) return;
    setCreating(true);
    setError(null);
    try {
      const block = await api.createSiteNoteBlock(siteId);
      setNotes((current) => current ? { ...current, blocks: [block, ...current.blocks] } : current);
      setCreatedBlockId(block.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="site-project-overview-layout">
      <aside className="site-project-data" aria-label="Projektdaten">{information}</aside>
      <section className="site-project-notes" aria-label="Projektnotizen">
        <div className={`site-project-general-notes${canEdit && notes ? " has-office-notes" : ""}`}>
          {children}
          {canEdit && notes ? <InternalNotes siteId={siteId} initial={notes} /> : null}
        </div>
        {canEdit && error && (
          <div className="site-project-notes-error">
            <p className="form-error" role="alert">{error}</p>
            {!notes && <button type="button" onClick={() => setReload((value) => value + 1)}>Erneut laden</button>}
          </div>
        )}
        {canEdit && atVisibleLimit && <p className="site-project-note-limit" role="status">
          Maximal 3 sichtbare Monteurinfos. Bitte zuerst einen Hinweis ausblenden.
        </p>}
        <div className="site-project-notes-grid">
          {canEdit && (notes ? <>
            {noteItems.map((block, index) => block ? <NoteBlock key={block.id} siteId={siteId} initial={block}
              placement={placement(index - (!atVisibleLimit && index > visibleCount ? 1 : 0))}
              canPublish={!atVisibleLimit} autoFocus={block.id === createdBlockId} onSaved={updateSavedBlock} onDeleted={removeDeletedBlock} />
              : <button key="create" className="site-project-note-create" style={placement(visibleCount, true)}
                type="button" aria-label="Neuer Notizblock" title="Neuen Notizblock anlegen" aria-busy={creating} disabled={creating}
                onClick={() => void createBlock()}>
                <Plus size={40} strokeWidth={1.5} aria-hidden="true" />
              </button>)}
          </> : !error && <p role="status">Projektnotizen werden geladen…</p>)}
        </div>
      </section>
    </div>
  );
}

function InternalNotes({ siteId, initial }: { siteId: number; initial: SiteNotes }) {
  const [content, setContent] = useState(initial.internal_notes);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const savedRef = useRef({ content: initial.internal_notes, revision: initial.internal_revision });
  const contentRef = useRef(initial.internal_notes);
  const savingRef = useRef(false);
  const failedRef = useRef(false);

  // Keep typing possible during a save; persist the latest draft with the new revision.
  const save = useCallback(async () => {
    if (deletingRef.current || savingRef.current || contentRef.current.trim() === savedRef.current.content) return;
    savingRef.current = true;
    failedRef.current = false;
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      while (contentRef.current.trim() !== savedRef.current.content) {
        const value = await api.updateSiteInternalNotes(siteId, contentRef.current.trim(), savedRef.current.revision);
        savedRef.current = { content: value.internal_notes, revision: value.internal_revision };
      }
      setMessage("Gespeichert");
    } catch (reason) {
      failedRef.current = true;
      setError(errorText(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [siteId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void save(), 1000);
    return () => window.clearTimeout(timer);
  }, [content, save]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (savingRef.current || contentRef.current.trim() !== savedRef.current.content) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (!failedRef.current) void save();
    };
  }, [save]);

  async function deleteContent() {
    if (savingRef.current || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.updateSiteInternalNotes(siteId, "", savedRef.current.revision);
      savedRef.current = { content: result.internal_notes, revision: result.internal_revision };
      contentRef.current = "";
      setContent("");
      failedRef.current = false;
      setError(null);
      setMessage("Notiz gelöscht");
    } catch (reason) {
      setDeleteError(errorText(reason));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  return (
    <section className="site-notes-section site-project-office-notes" aria-labelledby="site-internal-notes-heading">
      <div className="site-notes-header">
        <h2 id="site-internal-notes-heading"><FileText size={17} aria-hidden="true" />Projekt Notizen</h2>
        <div className="site-project-note-header-actions">
          <span className="site-project-note-visibility"><LockKeyhole size={13} aria-hidden="true" />Nur im Büro</span>
          <ProjectNoteDeleteButton title="Projekt Notizen" disabled={saving || deleting || (!content && !savedRef.current.content)} onDelete={() => void deleteContent()} />
        </div>
      </div>
      <p className="site-project-note-help">Diese Notizen werden Monteuren nicht angezeigt.</p>
      <ProjectNoteTextarea className="site-notes-textarea" aria-label="Projekt Notizen" maxLength={20000} value={content} disabled={deleting}
        placeholder="Interne Absprachen und Hinweise…" onChange={(event) => { contentRef.current = event.target.value; setContent(event.target.value); setMessage(""); }} />
      <span className="site-project-note-message" role="status">{deleting ? "Wird gelöscht…" : saving ? "Wird gespeichert…" : error ? "Nicht gespeichert" : message}</span>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      {error && <div className="site-project-note-error">
        <p className="form-error" role="alert">{error}</p>
        <button className="site-project-note-button" type="button" disabled={saving} onClick={() => void save()}>Erneut speichern</button>
      </div>}
    </section>
  );
}

function NoteBlock({ siteId, initial, autoFocus, onSaved, onDeleted, placement, canPublish }: {
  siteId: number;
  initial: SiteNoteBlock;
  autoFocus: boolean;
  placement: CSSProperties;
  canPublish: boolean;
  onSaved: (block: SiteNoteBlock) => void;
  onDeleted: (blockId: number) => void;
}) {
  const [saved, setSaved] = useState(initial);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const savedRef = useRef(initial);
  const contentRef = useRef(initial.content);
  const visibleRef = useRef(initial.visible_to_workers);
  const savingRef = useRef(false);
  const failedRef = useRef(false);
  const headingId = `site-note-block-${initial.id}`;

  // Serialize writes and always follow an in-flight save with the latest draft.
  // Server revisions and whitespace normalization must not overwrite newer input.
  const save = useCallback(async () => {
    if (deletingRef.current || savingRef.current) return;
    const isDirty = () => contentRef.current.trim() !== savedRef.current.content
      || visibleRef.current !== savedRef.current.visible_to_workers;
    if (!isDirty()) return;
    savingRef.current = true;
    failedRef.current = false;
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      while (isDirty()) {
        const previous = savedRef.current;
        const value = await api.updateSiteNoteBlock(siteId, previous.id, {
          title: previous.title,
          content: contentRef.current.trim(),
          visible_to_workers: visibleRef.current,
          expected_revision: previous.revision,
        });
        savedRef.current = value;
        setSaved(value);
        onSaved(value);
      }
      setMessage("Gespeichert");
    } catch (reason) {
      visibleRef.current = savedRef.current.visible_to_workers;
      failedRef.current = true;
      setError(errorText(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [siteId, onSaved]);

  useEffect(() => {
    const timer = window.setTimeout(() => void save(), 1000);
    return () => window.clearTimeout(timer);
  }, [content, save]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (savingRef.current || contentRef.current.trim() !== savedRef.current.content
        || visibleRef.current !== savedRef.current.visible_to_workers) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (!failedRef.current) void save();
    };
  }, [save]);

  async function deleteBlock() {
    if (savingRef.current || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSiteNoteBlock(siteId, savedRef.current.id, savedRef.current.revision);
      // Keep autosave paused during unmount: a pending draft must never recreate a deleted note.
      onDeleted(savedRef.current.id);
    } catch (reason) {
      deletingRef.current = false;
      setDeleting(false);
      setDeleteError(errorText(reason));
    }
  }

  return (
    <section className={`site-notes-section site-project-note-block${saved.visible_to_workers ? "" : " is-unpublished"}`} aria-labelledby={headingId} style={placement}>
      <div className="site-notes-header">
        <h3 id={headingId}><FileText size={17} aria-hidden="true" />{saved.title}</h3>
        <ProjectNoteDeleteButton title={saved.title} disabled={saving || deleting} onDelete={() => void deleteBlock()} />
      </div>
      <div className="site-project-note-meta">
        <time dateTime={saved.created_at}>{new Date(saved.created_at).toLocaleDateString("de-DE")}</time>
        <label className="site-project-note-share" title={!saved.visible_to_workers && !canPublish ? "Bitte zuerst eine andere Monteurinfo ausblenden" : "Diese Notiz für Monteure sichtbar machen"}>
          <input type="checkbox" aria-label="Für Monteur sichtbar" checked={saved.visible_to_workers}
            disabled={saving || deleting || (!saved.visible_to_workers && !canPublish)}
            onChange={(event) => { visibleRef.current = event.target.checked; void save(); }} />
          <span>Für Monteur sichtbar</span>
        </label>
      </div>
      <ProjectNoteTextarea className="site-notes-textarea" aria-label={`Notiz: ${saved.title}`} maxLength={20000}
        value={content} disabled={deleting} autoFocus={autoFocus} placeholder="Aktuellen Projektstand eintragen…"
        onChange={(event) => { contentRef.current = event.target.value; setContent(event.target.value); setMessage(""); }} />
      <span className="site-project-note-message" role="status">{deleting ? "Wird gelöscht…" : saving ? "Wird gespeichert…" : error ? "Nicht gespeichert" : message}</span>
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      {error && <div className="site-project-note-error">
        <p className="form-error" role="alert">{error}</p>
        <button className="site-project-note-button" type="button" disabled={saving || deleting} onClick={() => void save()}>Erneut speichern</button>
      </div>}
    </section>
  );
}
