import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LockKeyhole, Plus } from "lucide-react";

import { api } from "../lib/api";
import type { SiteNoteBlock, SiteNotes } from "../types/site";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Die Notiz konnte nicht gespeichert werden. Bitte erneut versuchen.";
}

export function SiteProjectNotes({ siteId, canEdit, children, renderInformation }: {
  siteId: number;
  canEdit: boolean;
  children: ReactNode;
  renderInformation: (projectNotes: ReactNode) => ReactNode;
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

  async function createBlock() {
    if (creating) return;
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
    <>
      {renderInformation(canEdit && notes ? <InternalNotes siteId={siteId} initial={notes} /> : null)}
      <section className="site-project-notes" aria-label="Projektnotizen">
        {canEdit && error && (
          <div className="site-project-notes-error">
            <p className="form-error" role="alert">{error}</p>
            {!notes && <button type="button" onClick={() => setReload((value) => value + 1)}>Erneut laden</button>}
          </div>
        )}
        <div className="site-project-notes-grid">
          {children}
          {canEdit && (notes ? <>
            {notes.blocks.map((block) => <NoteBlock key={block.id} siteId={siteId} initial={block} autoFocus={block.id === createdBlockId} />)}
          </> : !error && <p role="status">Projektnotizen werden geladen…</p>)}
          {canEdit && <button className="site-project-note-create" type="button" aria-label="Neuer Notizblock"
            title="Neuen Notizblock anlegen" aria-busy={creating} disabled={creating || !notes}
            onClick={() => void createBlock()}>
            <Plus size={40} strokeWidth={1.5} aria-hidden="true" />
          </button>}
        </div>
      </section>
    </>
  );
}

function InternalNotes({ siteId, initial }: { siteId: number; initial: SiteNotes }) {
  const [content, setContent] = useState(initial.internal_notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const savedRef = useRef({ content: initial.internal_notes, revision: initial.internal_revision });
  const contentRef = useRef(initial.internal_notes);
  const savingRef = useRef(false);
  const failedRef = useRef(false);

  // Keep typing possible during a save; persist the latest draft with the new revision.
  const save = useCallback(async () => {
    if (savingRef.current || contentRef.current.trim() === savedRef.current.content) return;
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

  return (
    <section className="site-notes-section site-project-office-notes" aria-labelledby="site-internal-notes-heading">
      <div className="site-notes-header">
        <h2 id="site-internal-notes-heading">Projekt Notizen</h2>
        <span className="site-project-note-visibility"><LockKeyhole size={13} aria-hidden="true" />Nur im Büro</span>
      </div>
      <p className="site-project-note-help">Diese Notizen werden Monteuren nicht angezeigt.</p>
      <textarea className="site-notes-textarea" aria-label="Projekt Notizen" maxLength={20000} value={content}
        placeholder="Interne Absprachen und Hinweise…" onChange={(event) => { contentRef.current = event.target.value; setContent(event.target.value); setMessage(""); }} />
      <span className="site-project-note-message" role="status">{saving ? "Wird gespeichert…" : error ? "Nicht gespeichert" : message}</span>
      {error && <div className="site-project-note-error">
        <p className="form-error" role="alert">{error}</p>
        <button className="site-project-note-button" type="button" disabled={saving} onClick={() => void save()}>Erneut speichern</button>
      </div>}
    </section>
  );
}

function NoteBlock({ siteId, initial, autoFocus }: { siteId: number; initial: SiteNoteBlock; autoFocus: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
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
    if (savingRef.current) return;
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

  return (
    <section className="site-notes-section site-project-note-block" aria-labelledby={headingId}>
      <div className="site-project-note-heading">
        <div>
          <h3 id={headingId}>{saved.title}</h3>
          <time dateTime={saved.created_at}>{new Date(saved.created_at).toLocaleDateString("de-DE")}</time>
        </div>
        <label className="site-project-note-share" title="Diese Notiz für Monteure sichtbar machen">
          <input type="checkbox" aria-label="Für Monteure sichtbar" checked={saved.visible_to_workers}
            disabled={saving || (!content.trim() && !saved.visible_to_workers)}
            onChange={(event) => { visibleRef.current = event.target.checked; void save(); }} />
          <span>Für Monteure</span>
        </label>
      </div>
      <textarea className="site-notes-textarea" aria-label={`Notiz: ${saved.title}`} maxLength={20000}
        value={content} autoFocus={autoFocus} placeholder="Aktuellen Projektstand eintragen…"
        onChange={(event) => { contentRef.current = event.target.value; setContent(event.target.value); setMessage(""); }} />
      <span className="site-project-note-message" role="status">{saving ? "Wird gespeichert…" : error ? "Nicht gespeichert" : message}</span>
      {error && <div className="site-project-note-error">
        <p className="form-error" role="alert">{error}</p>
        <button className="site-project-note-button" type="button" disabled={saving} onClick={() => void save()}>Erneut speichern</button>
      </div>}
    </section>
  );
}
