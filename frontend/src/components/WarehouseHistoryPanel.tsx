import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, FileCheck2, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, ApiError } from "../lib/api";
import { SIGNATURE_SVG_HEIGHT, SIGNATURE_SVG_WIDTH, signatureStrokeToSvgPoints, validSignatureStrokes } from "../lib/signatureCanvas";
import { warehouseHistoryDate, warehouseHistoryPageSize, warehouseHistorySearch } from "../lib/warehouseHistory";
import { warehouseToolIdentity } from "../lib/warehouseWorkflow";
import type { WarehouseDirection, WarehouseHistoryDetail, WarehouseHistoryEntry, WarehouseHistoryPage, WarehouseReviewStatus } from "../types/warehouse";
import { EntityDetailDrawer } from "./EntityDetailDrawer";
import "./WarehouseHistoryPanel.css";

export function WarehouseHistoryPanel() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [direction, setDirection] = useState<WarehouseDirection | "">("");
  const [reviewStatus, setReviewStatus] = useState<WarehouseReviewStatus | "">("");
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const pendingReview = useRef(false);
  const reviewEpoch = useRef(0);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<WarehouseHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WarehouseHistoryEntry | null>(null);
  const refresh = useRef<() => void>(() => {});
  const invalidDates = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const query = warehouseHistorySearch({ search: debouncedSearch, direction, reviewStatus, dateFrom, dateTo, page });

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (invalidDates) { setData(null); setLoading(false); return; }
    const controller = new AbortController();
    let running = false;
    setData(null); setLoading(true); setError("");
    async function load() {
      if (running || controller.signal.aborted) return;
      if (pendingReview.current) return;
      const epoch = reviewEpoch.current;
      running = true; setRefreshing(true);
      try {
        const result = await api.warehouseHistory(query, controller.signal);
        if (!controller.signal.aborted && epoch === reviewEpoch.current) {
          setData(result); setError("");
          if (result.total > 0 && !result.items.length && page > 1) setPage(Math.ceil(result.total / warehouseHistoryPageSize));
        }
      } catch (requestError) {
        if (!controller.signal.aborted) setError(errorText(requestError, "Lagerbuchungen konnten nicht geladen werden."));
      } finally {
        running = false;
        if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
      }
    }
    const reloadVisible = () => { if (document.visibilityState === "visible") void load(); };
    refresh.current = () => { void load(); };
    void load();
    const timer = window.setInterval(reloadVisible, 15_000);
    window.addEventListener("focus", reloadVisible);
    document.addEventListener("visibilitychange", reloadVisible);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", reloadVisible);
      document.removeEventListener("visibilitychange", reloadVisible);
      refresh.current = () => {};
    };
  }, [query, invalidDates, page, reloadKey]);

  async function toggleReview(entry: WarehouseHistoryEntry) {
    if (pendingReview.current || !data?.can_review) return;
    pendingReview.current = true; reviewEpoch.current += 1;
    setReviewingId(entry.id); setReviewError("");
    try {
      await api.reviewWarehouseMovement(entry.id, entry.review_status !== "reviewed", entry.review_version);
    } catch (requestError) {
      setReviewError(errorText(requestError, "Prüfstatus konnte nicht gespeichert werden. Bitte den aktualisierten Stand prüfen."));
    } finally {
      pendingReview.current = false; setReviewingId(null); setReloadKey((value) => value + 1);
    }
  }

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / warehouseHistoryPageSize);
  return <section className="warehouse-history-panel miscellaneous-tools-panel" id="tool-movements-panel" role="tabpanel" aria-labelledby="tool-movements-tab">
    <header className="miscellaneous-tools-header">
      <div><h2>Ausgaben / Rückgaben</h2><p>Signierte Übergaben aus dem Lager. Neueste Buchungen zuerst.</p></div>
      <div className="warehouse-history-refresh"><span>Automatisch · alle 15 Sek.</span><button type="button" className="miscellaneous-tools-reset-filters" disabled={refreshing || invalidDates} onClick={() => refresh.current()}>
        <RefreshCw size={15} aria-hidden="true" />{refreshing ? "Wird aktualisiert …" : "Aktualisieren"}</button></div>
    </header>
    <div className="warehouse-history-filters">
      <label className="overview-search warehouse-history-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Lagerbuchungen suchen" placeholder="Monteur, BEG-Nr., Werkzeug oder Beleg suchen" value={search} maxLength={160} onChange={(event) => setSearch(event.target.value)} /></label>
      <label><span>Vorgang</span><select value={direction} onChange={(event) => { setDirection(event.target.value as WarehouseDirection | ""); setPage(1); }}>
        <option value="">Alle Vorgänge</option><option value="issue">Ausgaben</option><option value="return">Rückgaben</option></select></label>
      <label><span>Status</span><select value={reviewStatus} onChange={(event) => { setReviewStatus(event.target.value as WarehouseReviewStatus | ""); setPage(1); }}>
        <option value="">Alle Status</option><option value="unreviewed">Ungeprüft</option><option value="reviewed">Geprüft</option></select></label>
      <label><span>Von</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} /></label>
      <label><span>Bis</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} /></label>
      {(search || direction || reviewStatus || dateFrom || dateTo) && <button type="button" className="miscellaneous-tools-reset-filters" onClick={() => { setSearch(""); setDebouncedSearch(""); setDirection(""); setReviewStatus(""); setDateFrom(""); setDateTo(""); setPage(1); }}>Filter zurücksetzen</button>}
    </div>
    {invalidDates && <p className="form-error" role="alert">Das Enddatum darf nicht vor dem Startdatum liegen.</p>}
    {error && <p className="form-error" role="alert">{error} {data ? "Angezeigt wird der zuletzt geladene Stand." : "Bitte erneut aktualisieren."}</p>}
    {reviewError && <p className="form-error" role="alert">{reviewError}</p>}
    <div className="warehouse-history-table-wrap" aria-busy={loading}>
      <table className="warehouse-history-table"><thead><tr><th>Beleg</th><th>Datum / Uhrzeit</th><th>Vorgang</th><th>Monteur</th><th>Werkzeuge / Material</th><th>Lagerkonto</th><th>Status</th><th><span className="sr-only">Details und Prüfung</span></th></tr></thead>
        <tbody>{loading ? <tr><td colSpan={8} className="miscellaneous-tools-empty">Buchungen werden geladen …</td></tr> : data?.items.map((entry) => <tr key={entry.id} tabIndex={0} onClick={() => setSelected(entry)} onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelected(entry); }
        }} aria-label={`Beleg ${entry.id}, ${entry.direction === "issue" ? "Ausgabe" : "Rückgabe"}, ${entry.employee_name}`}>
          <td className="warehouse-history-receipt-id">#{entry.id}</td><td className="warehouse-history-date">{warehouseHistoryDate(entry.created_at)}</td><td><DirectionBadge direction={entry.direction} /></td>
          <td><strong>{entry.employee_name}</strong></td><td><div className="warehouse-history-tools"><strong>{entry.items.length} {entry.items.length === 1 ? "Eintrag" : "Einträge"}</strong>
            <span title={entry.items.map((item) => `${item.beg_number || "–"} · ${item.designation}`).join(", ")}>{entry.items.slice(0, 2).map((item) => `${item.beg_number || "–"} · ${item.designation}`).join(", ")}{entry.items.length > 2 ? ` · +${entry.items.length - 2} weitere` : ""}</span></div></td>
          <td>{entry.actor_name}</td><td><ReviewStatusBadge entry={entry} /></td><td><div className="warehouse-history-actions"><button type="button" className="warehouse-history-open" aria-label={`Beleg ${entry.id} mit Unterschrift öffnen`} onClick={(event) => { event.stopPropagation(); setSelected(entry); }}><FileCheck2 size={18} /><ChevronRight size={16} /></button>
            <button type="button" className={`warehouse-history-review time-review-payroll-mark ${entry.review_status === "reviewed" ? "is-reviewed time-review-reviewed-indicator" : "is-pending time-review-pending-indicator"}`}
              aria-pressed={entry.review_status === "reviewed"} aria-label={`Beleg ${entry.id} ${entry.review_status === "reviewed" ? "auf ungeprüft zurücksetzen" : "als geprüft markieren"}`}
              title={data.can_review ? (entry.review_status === "reviewed" ? "Prüfung zurücksetzen" : "Als geprüft markieren") : "Prüfung nur durch Werkzeug-Beauftragten oder Admin"}
              disabled={!data.can_review || reviewingId !== null} onClick={(event) => { event.stopPropagation(); void toggleReview(entry); }}>
              {reviewingId === entry.id ? "…" : entry.review_status === "reviewed" ? "✓" : null}
            </button></div></td>
        </tr>)}</tbody>
      </table>
      {!loading && !error && !invalidDates && !total && <div className="warehouse-history-empty"><FileCheck2 size={30} aria-hidden="true" /><h3>{search || direction || reviewStatus || dateFrom || dateTo ? "Keine passenden Buchungen" : "Noch keine Lagerbuchungen"}</h3><p>{search || direction || reviewStatus || dateFrom || dateTo ? "Bitte Suchbegriff oder Filter anpassen." : "Bestätigte Ausgaben und Rückgaben vom Lagertablet erscheinen hier automatisch – inklusive Unterschrift."}</p></div>}
    </div>
    <footer className="miscellaneous-tools-pagination"><span>{total ? `${(page - 1) * warehouseHistoryPageSize + 1}–${Math.min(page * warehouseHistoryPageSize, total)} von ${total}` : "0"} Buchungen</span><div>
      <button type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Zurück</button><span>Seite {totalPages ? page : 0} von {totalPages}</span><button type="button" disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}>Weiter</button>
    </div></footer>
    {selected && <WarehouseReceiptDrawer key={selected.id} entry={selected} onClose={() => setSelected(null)} />}
  </section>;
}

function WarehouseReceiptDrawer({ entry, onClose }: { entry: WarehouseHistoryEntry; onClose: () => void }) {
  const [detail, setDetail] = useState<WarehouseHistoryDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api.warehouseHistoryDetail(entry.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDetail(result);
    }).catch((requestError) => { if (!controller.signal.aborted) setError(errorText(requestError, "Der Beleg konnte nicht geladen werden.")); });
    return () => controller.abort();
  }, [entry.id, retry]);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    const dialog = closeButton.current?.closest('[role="dialog"]');
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { document.removeEventListener("keydown", trapFocus); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);
  const strokes = validSignatureStrokes(detail?.signature_strokes);
  return <EntityDetailDrawer isOpen title={`Beleg #${entry.id}`} eyebrow="LAGERBUCHUNG" subtitle={`${entry.direction === "issue" ? "Ausgabe" : "Rückgabe"} · ${entry.employee_name}`} onClose={onClose}
    footer={<button ref={closeButton} type="button" className="secondary" onClick={onClose}>Schließen</button>}>
    {error ? <div className="warehouse-receipt-error" role="alert"><p>{error}</p><button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>Erneut laden</button></div> : !detail ? <p role="status">Beleg wird geladen …</p> : <div className="warehouse-receipt-detail">
      <dl className="warehouse-receipt-meta">
        <div><dt>Vorgang</dt><dd><DirectionBadge direction={detail.direction} /></dd></div><div><dt>Gebucht am</dt><dd>{warehouseHistoryDate(detail.created_at)} Uhr</dd></div>
        <div><dt>Monteur / Unterzeichner</dt><dd>{detail.employee_name}</dd></div><div><dt>Lagerkonto</dt><dd>{detail.actor_name}</dd></div>
        <div><dt>Prüfstatus</dt><dd><ReviewStatusBadge entry={detail} /></dd></div>
        {detail.reviewed_at && <div><dt>Geprüft durch</dt><dd>{detail.reviewed_by_name || "–"}<br />{warehouseHistoryDate(detail.reviewed_at)} Uhr</dd></div>}
      </dl>
      <section><h3>Werkzeuge / Material <span>({detail.items.length})</span></h3><ul className="warehouse-receipt-items">{detail.items.map((item) => <li key={item.id}>
        <span>BEG-Nr. {item.beg_number || "–"}</span><strong>{item.designation}</strong><p>{[item.manufacturer, item.item_type].filter(Boolean).join(" · ")}</p><p>{warehouseToolIdentity(item)}</p>
      </li>)}</ul></section>
      <section className="warehouse-receipt-signature"><h3>Unterschrift des Monteurs</h3><p>Bestätigung {detail.direction === "issue" ? "des Empfangs" : "der Rückgabe"} der aufgeführten Werkzeuge.</p>
        {strokes.length ? <svg role="img" aria-label={`Gespeicherte Unterschrift von ${detail.employee_name}`} viewBox={`0 0 ${SIGNATURE_SVG_WIDTH} ${SIGNATURE_SVG_HEIGHT}`}>
          {strokes.map((stroke, index) => <polyline key={index} points={signatureStrokeToSvgPoints(stroke)} fill="none" stroke="#173658" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />)}
        </svg> : <p>Keine darstellbare Unterschrift vorhanden.</p>}
        <strong>{detail.employee_name}</strong><small>{warehouseHistoryDate(detail.created_at)} Uhr</small>
      </section>
      <p className="warehouse-receipt-note">Gespeicherter Stand zum Buchungszeitpunkt. Spätere Änderungen an Mitarbeitern oder Werkzeugen verändern diesen Beleg nicht.</p>
    </div>}
  </EntityDetailDrawer>;
}

function DirectionBadge({ direction }: { direction: WarehouseDirection }) {
  const Icon = direction === "issue" ? ArrowUpFromLine : ArrowDownToLine;
  return <span className={`warehouse-history-direction is-${direction}`}><Icon size={14} aria-hidden="true" />{direction === "issue" ? "Ausgabe" : "Rückgabe"}</span>;
}
function ReviewStatusBadge({ entry }: { entry: WarehouseHistoryEntry }) {
  return <span className={`warehouse-review-status is-${entry.review_status}`} title={entry.reviewed_at ? `Geprüft von ${entry.reviewed_by_name || "–"} am ${warehouseHistoryDate(entry.reviewed_at)}` : "Noch nicht geprüft"}>
    {entry.review_status === "reviewed" ? "Geprüft" : "Ungeprüft"}</span>;
}
function errorText(error: unknown, fallback: string): string { return error instanceof ApiError ? error.message : fallback; }
