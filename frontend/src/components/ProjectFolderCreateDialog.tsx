import { useEffect, useId, useRef, useState } from "react";
import { FolderPlus } from "lucide-react";
import { ApiError } from "../lib/api";

export function ProjectFolderCreateDialog({ parentName, onCreate, onClose }: {
  parentName: string;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const id = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function close() {
    // Close before unmounting so the native dialog restores focus to its opener.
    dialogRef.current?.close();
    onClose();
  }

  async function submit() {
    if (pendingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.endsWith(".") || /[\\/:*?"<>|]/.test(trimmed)
      || [...trimmed].some((character) => character.charCodeAt(0) < 32)) {
      setError("Bitte einen gültigen Ordnernamen ohne Sonderzeichen oder abschließenden Punkt eingeben.");
      return;
    }
    pendingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onCreate(trimmed);
      close();
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Ordner konnte nicht erstellt werden. Bitte erneut versuchen.");
    } finally {
      pendingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="project-folder-create-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-parent`}
      onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) close(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={saving}>
        <h2 id={`${id}-title`}><FolderPlus size={20} aria-hidden="true" />Ordner erstellen</h2>
        <p id={`${id}-parent`}>Neuer Unterordner in <strong>{parentName}</strong></p>
        <label htmlFor={`${id}-name`}>Ordnername</label>
        <input id={`${id}-name`} autoFocus value={name} maxLength={255} required disabled={saving}
          autoComplete="off" placeholder="z. B. Baustellenbesprechungen"
          aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => { setName(event.target.value); setError(null); }} />
        {error ? <p id={`${id}-error`} role="alert" className="project-folder-create-error">{error}</p> : null}
        <div className="project-folder-create-actions">
          <button type="button" className="secondary-action" disabled={saving} onClick={close}>Abbrechen</button>
          <button type="submit" className="primary-action" disabled={saving || !name.trim()}>{saving ? "Wird erstellt…" : "Erstellen"}</button>
        </div>
      </form>
    </dialog>
  );
}
