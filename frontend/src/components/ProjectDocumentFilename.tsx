import { useRef, useState } from "react";

export function ProjectDocumentFilename({ name, editable, onRename }: {
  name: string;
  editable: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const pending = useRef(false);

  function start(): void {
    if (!editable || pending.current) return;
    active.current = true;
    setDraft(name);
    setError(null);
    setEditing(true);
  }

  function cancel(): void {
    if (pending.current) return;
    active.current = false;
    setEditing(false);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!active.current || pending.current) return;
    const nextName = draft.trim();
    if (!nextName || nextName.endsWith(".") || /[\\/:*?"<>|\u0000-\u001f]/.test(nextName)) {
      setError("Bitte einen gültigen Dateinamen eingeben.");
      return;
    }
    if (nextName === name) { cancel(); return; }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onRename(nextName);
      active.current = false;
      setEditing(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Datei konnte nicht umbenannt werden.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (!editing) return (
    <strong
      className={editable ? "project-document-renamable" : undefined}
      title={editable ? `${name} – Doppelklick zum Umbenennen` : name}
      tabIndex={editable ? 0 : undefined}
      onDoubleClick={editable ? (event) => { event.stopPropagation(); start(); } : undefined}
      onKeyDown={editable ? (event) => {
        if (event.key === "F2" || event.key === "Enter") { event.preventDefault(); start(); }
      } : undefined}
    >{name}</strong>
  );

  return (
    <div className="project-document-rename-editor">
      <input
        aria-label="Dateiname bearbeiten"
        aria-invalid={Boolean(error)}
        autoFocus
        value={draft}
        maxLength={255}
        disabled={saving}
        onFocus={(event) => {
          const dot = event.target.value.lastIndexOf(".");
          event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
        }}
        onChange={(event) => { setDraft(event.target.value); setError(null); }}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
        }}
      />
      {error ? <span className="form-error" role="alert">{error}</span> : null}
    </div>
  );
}
