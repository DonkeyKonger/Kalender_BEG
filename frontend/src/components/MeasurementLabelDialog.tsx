import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import "./MeasurementLabelDialog.css";

export function MeasurementLabelDialog<T extends { internal_label?: string | null }>({ batch, title, onSave, onClose, documentKind = "Aufmaß" }: {
  batch: T;
  title: string;
  documentKind?: "Aufmaß" | "Zusatzauftrag";
  onSave: (batch: T, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [label, setLabel] = useState(batch.internal_label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await onSave(batch, label.trim()); onClose(); }
    catch (error) { setError(error instanceof ApiError && typeof error.detail === "string" ? error.detail : "Beschriftung konnte nicht gespeichert werden."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="measurement-label-dialog" aria-labelledby="measurement-label-title"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3 id="measurement-label-title">{documentKind} beschriften</h3>
      <p>{title}</p>
      <label htmlFor="measurement-internal-label">Interne Beschriftung</label>
      <input id="measurement-internal-label" autoFocus maxLength={120} value={label} disabled={busy}
        placeholder={`z. B. ${documentKind} Nachunternehmer`} aria-describedby="measurement-label-hint"
        onChange={event => setLabel(event.target.value)} />
      <p id="measurement-label-hint">Nur intern sichtbar, nicht auf PDFs oder in Kunden-E-Mails. Zum Entfernen das Feld leeren.</p>
      {error ? <p role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="secondary-action" disabled={busy} onClick={onClose}>Abbrechen</button>
        <button type="submit" className="primary-action" disabled={busy}>{busy ? "Wird gespeichert…" : "Speichern"}</button>
      </footer>
    </form>
  </dialog>;
}
