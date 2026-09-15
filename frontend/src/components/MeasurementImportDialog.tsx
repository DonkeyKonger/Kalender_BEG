import { useEffect, useId, useRef, useState } from "react";
import { File, FilePlus2, FileText, X } from "lucide-react";
import "./MeasurementImportDialog.css";

type Props = {
  fileName: string;
  mode: "append_existing" | "create_new";
  bases: { id: number; name: string }[];
  selectedBaseId: number | null;
  newBaseName: string;
  pending: boolean;
  error: string | null;
  onMode: (mode: Props["mode"]) => void;
  onBase: (id: number | null) => void;
  onName: (name: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
};

export function MeasurementImportDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [localPending, setLocalPending] = useState(false);
  const id = useId();
  const busy = props.pending || localPending;
  const valid = props.mode === "create_new" ? Boolean(props.newBaseName.trim())
    : props.bases.some((base) => base.id === props.selectedBaseId);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  function close() {
    if (props.pending || submitting.current) return;
    dialog.current?.close();
    props.onClose();
  }

  async function submit() {
    if (props.pending || submitting.current || !valid) return;
    submitting.current = true;
    setLocalPending(true);
    try { await props.onSubmit(); }
    finally { submitting.current = false; setLocalPending(false); }
  }

  return <dialog ref={dialog} className="measurement-import-dialog" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-hint`} onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom)) close();
    }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
      <div className="measurement-import-dialog-content">
        <header className="measurement-import-dialog-header">
          <div><h2 id={`${id}-title`}>Zeitenliste importieren</h2><p id={`${id}-hint`}>PDF einem Aufmaßblatt zuordnen.</p></div>
          <button type="button" className="measurement-import-dialog-close" aria-label="Schließen" disabled={busy} onClick={close}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="measurement-import-dialog-file"><FileText size={28} aria-hidden="true" /><span>{props.fileName}</span></div>
        <div className="measurement-import-dialog-options" role="radiogroup" aria-label="Importziel">
          <label className={`measurement-import-dialog-option${props.mode === "append_existing" ? " is-selected" : ""}${!props.bases.length ? " is-disabled" : ""}`}>
            <input type="radio" name={`${id}-mode`} checked={props.mode === "append_existing"} disabled={busy || !props.bases.length} onChange={() => props.onMode("append_existing")} />
            <FilePlus2 size={32} aria-hidden="true" />
            <span><strong>Bestehendes Aufmaßblatt ergänzen</strong><small>Für Nachträge und Ergänzungen.</small></span>
          </label>
          <label className={`measurement-import-dialog-option${props.mode === "create_new" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-mode`} checked={props.mode === "create_new"} disabled={busy} onChange={() => props.onMode("create_new")} />
            <File size={32} aria-hidden="true" />
            <span><strong>Neues Aufmaßblatt erstellen</strong><small>Für ein eigenständiges Aufmaß.</small></span>
          </label>
        </div>
        {props.mode === "append_existing" ? <div className="measurement-import-dialog-field">
          <label htmlFor={`${id}-base`}>Aufmaßblatt</label>
          <select id={`${id}-base`} value={props.selectedBaseId ?? ""} disabled={busy || !props.bases.length} onChange={(event) => props.onBase(Number(event.target.value) || null)}>
            {!props.bases.length ? <option value="">Kein Aufmaßblatt verfügbar</option> : null}
            {props.bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
          </select>
        </div> : <div className="measurement-import-dialog-field">
          <label htmlFor={`${id}-name`}>Name des Aufmaßblatts</label>
          <input id={`${id}-name`} value={props.newBaseName} disabled={busy} onChange={(event) => props.onName(event.target.value)} placeholder="Name des Aufmaßblatts" />
          <small>Das neue Aufmaßblatt wird nach dem Import automatisch aktiviert.</small>
        </div>}
        {props.error ? <p className="measurement-import-dialog-error" role="alert">{props.error}</p> : null}
      </div>
      <footer className="measurement-import-dialog-footer">
        <button type="button" className="secondary-action" disabled={busy} onClick={close}>Abbrechen</button>
        <button type="submit" className="primary-action" disabled={busy || !valid}>{busy ? "Importiert..." : "Importieren"}</button>
      </footer>
    </form>
  </dialog>;
}
