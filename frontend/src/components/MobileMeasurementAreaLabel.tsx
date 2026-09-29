import { useRef, useState } from "react";

export function MobileMeasurementAreaLabel({ area, disabled, onStart, onSave }: {
  area: string;
  disabled: boolean;
  onStart: () => Promise<boolean>;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(area);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const startingRef = useRef<Promise<boolean> | null>(null);
  const pendingRef = useRef(false);
  const cancelledRef = useRef(false);

  async function save() {
    if (pendingRef.current || cancelledRef.current || !startingRef.current) return;
    pendingRef.current = true;
    try {
      if (!await startingRef.current || cancelledRef.current) return;
      const label = value.trim().replace(/\s+/g, " ").toUpperCase();
      if (!label) { setError("Bitte Bauteil / Ort eintragen."); return; }
      if (label === area) { setValue(area); return; }
      setSaving(true);
      setError(null);
      await onSave(label);
      setValue(label);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ort konnte nicht geändert werden."); }
    finally { pendingRef.current = false; setSaving(false); }
  }

  return (
    <div className="measurement-matrix-area-editor">
      <input ref={inputRef} value={value} type="text" maxLength={1000} autoCapitalize="characters"
        autoCorrect="off" spellCheck={false}
        aria-label={`Bauteil / Ort ändern: ${area}`} aria-invalid={Boolean(error)}
        readOnly={disabled || saving}
        onFocus={() => {
          if (disabled || pendingRef.current) return;
          cancelledRef.current = false;
          startingRef.current = onStart().then((allowed) => {
            if (!allowed) { setValue(area); inputRef.current?.blur(); }
            return allowed;
          }).catch((cause) => {
            setError(cause instanceof Error ? cause.message : "Menge konnte nicht gespeichert werden.");
            return false;
          });
        }}
        onChange={(event) => setValue(event.target.value.toUpperCase())}
        onBlur={() => void save()} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          if (event.key === "Escape" && !pendingRef.current) {
            event.preventDefault(); cancelledRef.current = true; setValue(area); setError(null); inputRef.current?.blur();
          }
        }} />
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
