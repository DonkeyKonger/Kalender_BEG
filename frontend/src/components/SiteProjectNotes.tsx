import { type ReactNode, useEffect, useState } from "react";
import { LockKeyhole, Plus } from "lucide-react";

import { api } from "../lib/api";
import type { SiteNoteBlock, SiteNotes } from "../types/site";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Die Notiz konnte nicht gespeichert werden. Bitte erneut versuchen.";
}

export function SiteProjectNotes({ siteId, canEdit, children }: { siteId: number; canEdit: boolean; children: ReactNode }) {
  const [notes, setNotes] = useState<SiteNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="site-project-notes" aria-label="Projektnotizen">
      {canEdit && (
        <div className="site-project-notes-toolbar">
          <div>
            <h2>Projektnotizen</h2>
            <p className="site-project-note-help">Notizstände für Monteure: Nur freigegebene Blöcke sind mobil sichtbar. Frühere Stände bleiben erhalten.</p>
          </div>
          <button className="site-project-note-button" disabled={creating || !notes} type="button" onClick={() => void createBlock()}>
            <Plus size={15} aria-hidden="true" />{creating ? "Wird angelegt…" : "Neuer Notizblock"}
          </button>
        </div>
      )}
      {canEdit && error && (
        <div className="site-project-notes-error">
          <p className="form-error" role="alert">{error}</p>
          {!notes && <button type="button" onClick={() => setReload((value) => value + 1)}>Erneut laden</button>}
        </div>
      )}
      <div className="site-project-notes-grid">
        {children}
        {canEdit && (notes ? <>
          <InternalNotes siteId={siteId} initial={notes} />
          {notes.blocks.map((block) => <NoteBlock key={block.id} siteId={siteId} initial={block} />)}
        </> : !error && <p role="status">Projektnotizen werden geladen…</p>)}
      </div>
    </section>
  );
}

function InternalNotes({ siteId, initial }: { siteId: number; initial: SiteNotes }) {
  const [saved, setSaved] = useState({ content: initial.internal_notes, revision: initial.internal_revision });
  const [content, setContent] = useState(initial.internal_notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const dirty = content !== saved.content;

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const value = await api.updateSiteInternalNotes(siteId, content, saved.revision);
      setSaved({ content: value.internal_notes, revision: value.internal_revision });
      setContent(value.internal_notes);
      setMessage("Gespeichert");
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }

  return (
    <section className="site-notes-section" aria-labelledby="site-internal-notes-heading">
      <div className="site-notes-header">
        <h2 id="site-internal-notes-heading">Interne Notizen</h2>
        <span className="site-project-note-visibility"><LockKeyhole size={13} aria-hidden="true" />Nur im Büro</span>
      </div>
      <p className="site-project-note-help">Nur in der Projektakte sichtbar. Diese Notizen werden Monteuren nicht angezeigt.</p>
      <textarea className="site-notes-textarea" aria-label="Interne Notizen" maxLength={20000} value={content} disabled={saving}
        placeholder="Interne Absprachen und Hinweise…" onChange={(event) => { setContent(event.target.value); setMessage(""); }} />
      <div className="site-project-note-actions">
        <span role="status">{dirty ? "Ungespeicherte Änderungen" : message}</span>
        <button className="site-project-note-button" type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Wird gespeichert…" : "Speichern"}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function NoteBlock({ siteId, initial }: { siteId: number; initial: SiteNoteBlock }) {
  const [saved, setSaved] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(initial.visible_to_workers || !initial.content);
  const dirty = title !== saved.title || content !== saved.content;

  async function save(visible = saved.visible_to_workers) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const value = await api.updateSiteNoteBlock(siteId, saved.id, {
        title, content, visible_to_workers: visible, expected_revision: saved.revision,
      });
      setSaved(value);
      setTitle(value.title);
      setContent(value.content);
      setMessage("Gespeichert");
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }

  return (
    <details className="site-project-note-block" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span><strong>{saved.title}</strong><small>Stand {saved.number} · {new Date(saved.created_at).toLocaleDateString("de-DE")}</small></span>
        <span className={`site-project-note-visibility${saved.visible_to_workers ? " is-visible" : ""}`}>{saved.visible_to_workers ? "Für Monteure sichtbar" : "Nicht freigegeben"}</span>
      </summary>
      <div className="site-project-note-editor">
        <label>Titel<input type="text" maxLength={120} value={title} disabled={saving} onChange={(event) => { setTitle(event.target.value); setMessage(""); }} /></label>
        <label>Notiz<textarea className="site-notes-textarea" maxLength={20000} value={content} disabled={saving} placeholder="Aktuellen Projektstand eintragen…" onChange={(event) => { setContent(event.target.value); setMessage(""); }} /></label>
        <div className="site-project-note-actions">
          <label className="site-project-note-share"><input type="checkbox" checked={saved.visible_to_workers} disabled={saving || !title.trim() || (!content.trim() && !saved.visible_to_workers)} onChange={(event) => void save(event.target.checked)} />Für Monteure sichtbar</label>
          <button className="site-project-note-button" type="button" disabled={saving || !dirty || !title.trim()} onClick={() => void save()}>{saving ? "Wird gespeichert…" : "Speichern"}</button>
        </div>
        <small className="site-project-note-help">Die Auswahl speichert den Text und die Freigabe gemeinsam.</small>
        <span className="site-project-note-message" role="status">{dirty ? "Ungespeicherte Änderungen" : message}</span>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
