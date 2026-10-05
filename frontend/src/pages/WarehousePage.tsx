import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, Check, CheckCircle2, ChevronRight, LogOut, Search, Trash2, UserRound, Warehouse, X } from "lucide-react";

import { useAuth } from "../auth/AuthContext";
import { ToolMaterialCategoryIcon } from "../components/ToolMaterialCategoryIcon";
import { api, ApiError } from "../lib/api";
import { drawSignatureCanvas, getNormalizedSignaturePoint } from "../lib/signatureCanvas";
import { filterWarehousePeople, hasWarehouseSignature, toggleWarehouseTool, warehouseToolIdentity } from "../lib/warehouseWorkflow";
import type { CustomerSignatureStroke } from "../types/site";
import type { WarehouseBooking, WarehouseDirection, WarehousePerson, WarehouseReceipt, WarehouseTool, WarehouseToolPage } from "../types/warehouse";
import "./WarehousePage.css";

const directionTitle = { issue: "Werkzeugausgabe", return: "Werkzeugrückgabe" };
const bookingTitle = { issue: "Ausgabe bestätigen", return: "Rückgabe bestätigen" };

export function WarehousePage() {
  const { user, logout } = useAuth();
  const [direction, setDirection] = useState<WarehouseDirection | null>(null);
  const [person, setPerson] = useState<WarehousePerson | null>(null);
  const [selected, setSelected] = useState<WarehouseTool[]>([]);
  const [review, setReview] = useState(false);
  const [receipt, setReceipt] = useState<WarehouseReceipt | null>(null);
  const [locked, setLocked] = useState(false);
  const step = !person ? 1 : review ? 3 : 2;
  const dirty = selected.length > 0 || locked;

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [step, direction, receipt]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function reset() {
    setDirection(null); setPerson(null); setSelected([]); setReview(false); setReceipt(null); setLocked(false);
  }
  function cancel() {
    if (!dirty || window.confirm("Auswahl verwerfen und zurück zur Startseite? Es wird nichts gebucht.")) reset();
  }

  return <div className="warehouse-workspace">
    <header className="warehouse-header">
      <div className="warehouse-brand">
        <img src="/beg-sidebar-logo.svg" alt="BEG Logo" width={44} height={44} />
        <div><strong>BEG · Lager</strong><span>{user?.display_name}</span></div>
      </div>
      <button className="wh-button wh-quiet" type="button" disabled={locked} onClick={() => {
        if (!dirty || window.confirm("Auswahl verwerfen und abmelden?")) void logout();
      }}><LogOut size={20} aria-hidden="true" />Abmelden</button>
    </header>
    <main className="warehouse-main">
      {!direction && !receipt && <>
        <div className="wh-intro"><h1>Was möchtest du tun?</h1>
          <p>Werkzeug abholen oder zurückgeben – in drei einfachen Schritten.</p></div>
        <div className="wh-start-grid">
          <button className="wh-start-card" type="button" onClick={() => setDirection("issue")}>
            <span className="wh-large-icon"><ArrowUpFromLine size={38} /></span><span className="wh-card-label">Werkzeug abholen</span>
            <span className="wh-muted">Vom Lager mitnehmen</span><span className="wh-start-link">Ausgabe starten <ArrowRight size={22} /></span>
          </button>
          <button className="wh-start-card" type="button" onClick={() => setDirection("return")}>
            <span className="wh-large-icon"><ArrowDownToLine size={38} /></span><span className="wh-card-label">Werkzeug zurückgeben</span>
            <span className="wh-muted">Wieder im Lager abgeben</span><span className="wh-start-link">Rückgabe starten <ArrowRight size={22} /></span>
          </button>
        </div>
        <p className="wh-start-note"><Warehouse size={19} aria-hidden="true" />Monteur wählen · Werkzeug auswählen · Unterschreiben</p>
      </>}
      {direction && !receipt && <>
        <div className="wh-flow-heading"><div><span className="wh-eyebrow">LAGER</span><h1>{directionTitle[direction]}</h1></div>
          <button className="wh-button wh-quiet" type="button" disabled={locked} onClick={cancel}><X size={20} />Abbrechen</button></div>
        <ol className="wh-steps" aria-label="Fortschritt">
          {["Monteur", "Werkzeuge", "Unterschrift"].map((label, index) => <li key={label} className={step === index + 1 ? "is-current" : step > index + 1 ? "is-done" : ""} aria-current={step === index + 1 ? "step" : undefined}>
            <span>{step > index + 1 ? <Check size={17} /> : index + 1}</span>{label}
          </li>)}
        </ol>
        {!person && <PersonSelection direction={direction} onSelect={setPerson} />}
        {person && !review && <ToolSelection direction={direction} person={person} selected={selected} onToggle={(item) => setSelected((items) => toggleWarehouseTool(items, item))}
          onBack={() => { if (!selected.length || window.confirm("Monteur wechseln und Werkzeugauswahl leeren?")) { setPerson(null); setSelected([]); } }} onNext={() => setReview(true)} />}
        {person && review && <BookingReview direction={direction} person={person} items={selected} onBack={() => setReview(false)} onLock={setLocked} onSaved={(saved) => {
          setSelected([]); setPerson(null); setReview(false); setLocked(false); setReceipt(saved);
        }} />}
      </>}
      {receipt && <section className="wh-success" aria-labelledby="wh-success-title">
        <span className="wh-large-icon"><CheckCircle2 size={42} /></span><span className="wh-eyebrow">VORGANG ABGESCHLOSSEN</span>
        <h1 id="wh-success-title">{receipt.direction === "issue" ? "Werkzeug ausgegeben" : "Werkzeug zurückgenommen"}</h1>
        <p>{receipt.items.length} {receipt.items.length === 1 ? "Eintrag" : "Einträge"} · {receipt.employee_name}</p>
        <p className="wh-muted">Mit Unterschrift gespeichert · Beleg #{receipt.id}</p>
        <button type="button" className="wh-button wh-primary" onClick={reset}>Fertig – zurück zum Start <ArrowRight size={22} /></button>
      </section>}
    </main>
  </div>;
}

function PersonSelection({ direction, onSelect }: { direction: WarehouseDirection; onSelect: (person: WarehousePerson) => void }) {
  const [people, setPeople] = useState<WarehousePerson[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api.warehousePeople(direction, controller.signal).then(setPeople).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(errorText(err));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [direction, retry]);
  const filtered = filterWarehousePeople(people, search);
  return <section className="wh-panel">
    <div className="wh-section-heading"><h2>Wer {direction === "issue" ? "holt Werkzeug ab" : "gibt Werkzeug zurück"}?</h2></div>
    <SearchField label="Monteur suchen" value={search} onChange={setSearch} placeholder="Name oder Kürzel suchen …" />
    {error ? <LoadError message={error} onRetry={() => setRetry((value) => value + 1)} /> : loading ? <p role="status">Monteure werden geladen …</p> : <>
      <div className="wh-people-grid">{filtered.map((entry) => <button className="wh-person" type="button" key={entry.id} onClick={() => onSelect(entry)}>
        <span className="wh-person-avatar"><UserRound size={23} aria-hidden="true" /></span><span><strong>{entry.display_name}</strong><small>{entry.short_code}</small></span><ChevronRight size={20} aria-hidden="true" />
      </button>)}</div>
      {!filtered.length && <p className="wh-empty">{search ? "Kein passender Monteur gefunden." : direction === "return" ? "Derzeit ist keinem Mitarbeiter Werkzeug zugeordnet." : "Keine aktiven Mitarbeiter vorhanden."}</p>}
    </>}
  </section>;
}

function ToolSelection({ direction, person, selected, onToggle, onBack, onNext }: {
  direction: WarehouseDirection; person: WarehousePerson; selected: WarehouseTool[];
  onToggle: (item: WarehouseTool) => void; onBack: () => void; onNext: () => void;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<WarehouseToolPage>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = window.setTimeout(() => {
      void api.warehouseTools(direction, person.id, search, offset, controller.signal).then(setPage).catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [direction, person.id, search, offset, retry]);
  return <>
    <div className="wh-context"><button className="wh-button wh-quiet" type="button" onClick={onBack}><ArrowLeft size={20} />Monteur ändern</button><strong><UserRound size={20} />{person.display_name}</strong></div>
    <section className="wh-panel">
      <div className="wh-section-heading"><h2>Werkzeuge auswählen</h2><p>{direction === "issue" ? "Verfügbare Werkzeuge im Lager. Werkzeuge mit offenen Meldungen sind ausgeschlossen." : "Diese Werkzeuge sind dir zugeordnet. Wähle aus, was du zurückgibst."}</p></div>
      <SearchField label="Werkzeug suchen" value={search} onChange={(value) => { setLoading(true); setSearch(value); setOffset(0); }} placeholder="BEG-Nr. oder Werkzeug suchen …" />
      {selected.length > 0 && <div className="wh-selection" aria-label="Ausgewählte Werkzeuge">
        <span>{selected.length} ausgewählt</span>{selected.map((item) => <button type="button" key={item.id} onClick={() => onToggle(item)} aria-label={`${item.beg_number || "Ohne BEG-Nr."} · ${item.item_type || "Ohne Typ"} aus Auswahl entfernen`}>
          {item.beg_number || "Ohne BEG-Nr."} · {item.item_type || "Ohne Typ"}<X size={16} />
        </button>)}
      </div>}
      {selected.length === 100 && <p role="status">Maximal 100 Einträge pro Vorgang.</p>}
      {error ? <LoadError message={error} onRetry={() => setRetry((value) => value + 1)} /> : loading ? <p role="status">Werkzeuge werden geladen …</p> : <>
        <div className="wh-tools-grid">{page.items.map((item) => {
          const checked = selected.some((entry) => entry.id === item.id);
          return <button key={item.id} type="button" className={`wh-tool ${checked ? "is-selected" : ""}`} aria-pressed={checked}
            disabled={!checked && selected.length === 100} onClick={() => onToggle(item)}>
            <span className="wh-tool-icon"><ToolMaterialCategoryIcon category={item.category} size={26} /></span><ToolLabel item={item} />
            <span className="wh-check" aria-hidden="true">{checked && <Check size={18} />}</span>
          </button>;
        })}</div>
        {!page.items.length && <p className="wh-empty">{search ? "Kein passendes Werkzeug gefunden. Bitte BEG-Nr. prüfen." : "Keine Werkzeuge für diesen Vorgang verfügbar."}</p>}
        {page.total > 40 && <nav className="wh-pagination" aria-label="Werkzeugseiten">
          <button className="wh-button" type="button" disabled={offset === 0} onClick={() => { setLoading(true); setOffset((value) => value - 40); }}>Zurück</button>
          <span>{offset + 1}–{Math.min(offset + 40, page.total)} von {page.total}</span>
          <button className="wh-button" type="button" disabled={offset + 40 >= page.total} onClick={() => { setLoading(true); setOffset((value) => value + 40); }}>Weitere</button>
        </nav>}
      </>}
    </section>
    <div className="wh-action-bar"><span><strong>{selected.length}</strong> {selected.length === 1 ? "Werkzeug ausgewählt" : "Werkzeuge ausgewählt"}</span>
      <button type="button" className="wh-button wh-primary" disabled={!selected.length} onClick={onNext}>Weiter zur Unterschrift <ArrowRight size={21} /></button></div>
  </>;
}

function BookingReview({ direction, person, items, onBack, onLock, onSaved }: {
  direction: WarehouseDirection; person: WarehousePerson; items: WarehouseTool[];
  onBack: () => void; onLock: (locked: boolean) => void; onSaved: (receipt: WarehouseReceipt) => void;
}) {
  const [strokes, setStrokes] = useState<CustomerSignatureStroke[]>([]);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<WarehouseBooking | null>(null);
  const inFlight = useRef(false);
  const frozen = saving || uncertain;
  async function save() {
    if (inFlight.current || !hasWarehouseSignature(strokes)) return;
    inFlight.current = true; setSaving(true); onLock(true); setError("");
    // Retry the exact signed request after a lost response; never generate another booking.
    const payload = pending.current ?? {
      request_id: crypto.randomUUID(), direction, employee_id: person.id, tool_ids: items.map((item) => item.id),
      signature_strokes: strokes.filter((stroke) => stroke.length >= 2),
    };
    pending.current = payload;
    try { onSaved(await api.bookWarehouseMovement(payload)); }
    catch (err) {
      const isUncertain = !(err instanceof ApiError && err.status >= 400 && err.status < 500);
      setUncertain(isUncertain); onLock(isUncertain);
      if (!isUncertain) pending.current = null;
      setError(isUncertain ? "Die Bestätigung ist noch offen. Bitte Verbindung prüfen und erneut bestätigen. Derselbe Vorgang wird nicht doppelt gebucht." : errorText(err));
    } finally { inFlight.current = false; setSaving(false); }
  }
  return <>
    <div className="wh-context"><button type="button" className="wh-button wh-quiet" disabled={frozen} onClick={onBack}><ArrowLeft size={20} />Auswahl ändern</button><strong><UserRound size={20} />{person.display_name}</strong></div>
    <div className="wh-review-grid">
      <section className="wh-panel"><div className="wh-section-heading"><h2>{direction === "issue" ? "Das nimmst du mit" : "Das gibst du zurück"}</h2><p>{items.length} {items.length === 1 ? "Werkzeug" : "Werkzeuge"} · Bitte Auswahl prüfen.</p></div>
        <ul className="wh-review-items">{items.map((item) => <li key={item.id}><ToolMaterialCategoryIcon category={item.category} size={24} /><ToolLabel item={item} showIdentity /></li>)}</ul>
      </section>
      <section className="wh-panel wh-signature-panel"><div className="wh-section-heading"><h2>Deine Unterschrift</h2><p>Ich bestätige {direction === "issue" ? "den Empfang" : "die Rückgabe"} der aufgeführten Werkzeuge.</p></div>
        <strong className="wh-signer">{person.display_name}</strong>
        <SignaturePad strokes={strokes} onChange={setStrokes} disabled={frozen} />
        <button className="wh-button wh-quiet wh-clear-signature" type="button" disabled={frozen || !strokes.length} onClick={() => setStrokes([])}><Trash2 size={18} />Unterschrift leeren</button>
        {error && <p className="wh-error" role="alert">{error}</p>}
        <button className="wh-button wh-primary wh-confirm" type="button" disabled={saving || !hasWarehouseSignature(strokes)} onClick={() => void save()}>
          {saving ? "Wird gespeichert …" : uncertain ? "Erneut bestätigen" : bookingTitle[direction]}<Check size={22} /></button>
        <p className="wh-footnote">Erst mit dieser Bestätigung wird der Vorgang gebucht.</p>
      </section>
    </div>
  </>;
}

function SignaturePad({ strokes, onChange, disabled }: { strokes: CustomerSignatureStroke[]; onChange: (value: CustomerSignatureStroke[]) => void; disabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<number | null>(null);
  const live = useRef(strokes);
  live.current = strokes;
  useEffect(() => { drawSignatureCanvas(canvas.current, strokes); }, [strokes]);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(() => drawSignatureCanvas(canvas.current, live.current));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  return <div className="wh-signature-wrap"><span>Hier mit dem Finger oder Stift unterschreiben</span>
    <canvas ref={canvas} aria-label="Unterschrift zeichnen" className="wh-signature" onPointerDown={(event) => {
      if (disabled || drawing.current !== null || !event.isPrimary || event.button !== 0 || live.current.length >= 100) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drawing.current = event.pointerId;
      const point = getNormalizedSignaturePoint(event.currentTarget, event.clientX, event.clientY);
      if (point) { live.current = [...live.current, [point]]; onChange(live.current); }
    }} onPointerMove={(event) => {
      if (disabled || drawing.current !== event.pointerId) return;
      event.preventDefault();
      const point = getNormalizedSignaturePoint(event.currentTarget, event.clientX, event.clientY);
      const last = live.current.at(-1);
      if (point && last && last.length < 4000 && live.current.reduce((count, stroke) => count + stroke.length, 0) < 12000) {
        live.current = [...live.current.slice(0, -1), [...last, point]]; onChange(live.current);
      }
    }} onPointerUp={(event) => {
      if (drawing.current !== event.pointerId) return;
      drawing.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drawing.current = null; }} onLostPointerCapture={() => { drawing.current = null; }} />
  </div>;
}

function ToolLabel({ item, showIdentity = false }: { item: WarehouseTool; showIdentity?: boolean }) {
  return <span className="wh-tool-label"><strong>{item.designation}</strong>
    <small>{[item.manufacturer, item.beg_number || "Ohne BEG-Nr.", item.item_type].filter(Boolean).join(" · ")}</small>
    {showIdentity && <small>{warehouseToolIdentity(item)}</small>}</span>;
}
function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="wh-search"><Search size={23} aria-hidden="true" /><input type="search" aria-label={label} value={value} maxLength={160} autoComplete="off" placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="wh-error" role="alert"><p>{message}</p><button className="wh-button" type="button" onClick={onRetry}>Erneut laden</button></div>;
}
function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Verbindung nicht verfügbar. Bitte erneut versuchen.";
}
