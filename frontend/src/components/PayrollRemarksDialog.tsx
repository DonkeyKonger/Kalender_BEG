import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { normalizePayrollRemarks, payrollRemarksError, wrapPayrollRemarks, type PayrollRemarks } from "../lib/payrollRemarks";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Bemerkungen konnten nicht geladen oder gespeichert werden. Bitte erneut versuchen.";
}

export function PayrollRemarksDialog({ year, month, personId, canEdit, onClose }: {
  year: number; month: number; personId: number; canEdit: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [data, setData] = useState<PayrollRemarks | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const editable = canEdit && data?.editable && !blocked;

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    let ignore = false;
    api.payrollRemarks({ year, month, personId }).then((result) => {
      if (!ignore) { setData(result); setDraft(result.remarks); }
    }).catch((failure) => { if (!ignore) setError(errorMessage(failure)); });
    return () => { ignore = true; element.close(); previousFocus?.focus(); };
  }, [year, month, personId]);

  useEffect(() => { if (data) input.current?.focus(); }, [data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!data || !editable || saving) return;
    const validation = payrollRemarksError(draft, data.layout);
    if (validation) { setError(validation); return; }
    setSaving(true);
    setError(null);
    try {
      await api.savePayrollRemarks({ year, month, personId, remarks: draft });
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && (failure.status === 409 || failure.status === 403)) setBlocked(true);
    } finally { setSaving(false); }
  }

  return (
    <dialog ref={dialog} className="payroll-remarks-dialog" aria-labelledby="payroll-remarks-title"
      aria-describedby="payroll-remarks-hint" onCancel={(event) => {
        event.preventDefault(); if (!saving) onClose();
      }}>
      <form onSubmit={(event) => void save(event)}>
        <header>
          <h2 id="payroll-remarks-title">Bemerkungen hinzufügen</h2>
          <button type="button" aria-label="Schließen" disabled={saving} onClick={onClose}><X size={18} /></button>
        </header>
        <p id="payroll-remarks-hint">Nur vor der Monatsprüfung möglich. Danach ist die Eingabe gesperrt.</p>
        {data ? <>
          <textarea ref={input} aria-label="Bemerkung" aria-describedby="payroll-remarks-capacity payroll-remarks-hint"
            placeholder="Bemerkung eingeben …" rows={4} value={draft} disabled={!editable || saving}
            onChange={(event) => {
              const next = normalizePayrollRemarks(event.target.value);
              const validation = payrollRemarksError(next, data.layout);
              setError(validation ? `Eingabe nicht übernommen: ${validation}` : null);
              if (!validation) setDraft(next);
            }} />
          <small id="payroll-remarks-capacity" aria-live="polite">
            Platz in Excel: {wrapPayrollRemarks(draft, data.layout).length} von {data.layout.max_lines} Zeilen
          </small>
          {!editable && <p role="status">Die Eingabe ist für diesen Monteurmonat gesperrt.</p>}
        </> : <p role="status">{error ? "" : "Bemerkungen werden geladen …"}</p>}
        {error && <p className="payroll-remarks-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>Abbrechen</button>
          <button className="is-primary" type="submit" disabled={!editable || saving}>
            {saving ? "Speichert …" : "Speichern"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
