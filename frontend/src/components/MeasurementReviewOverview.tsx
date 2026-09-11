import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { FileText, MailCheck, MailX, Plus, Ruler, Search } from "lucide-react";
import type { MobileMeasurementBatch, Site } from "../types/site";
import { getCustomerEmailStatus } from "../lib/customerEmailStatus";
import { calculateExtraWorkOverviewPageSize, EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE, EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE, formatExtraWorkOverviewCreatorName, getExtraWorkOverviewMasterHeight, getExtraWorkOverviewPageItems } from "../lib/extraWorkOverview";
import { formatMeasurementCount, formatMeasurementOverviewHours, getMeasurementOverviewWindow } from "../lib/measurementReviewOverview";
import type { MeasurementOverviewState } from "../lib/measurementReviewOverview";
import "./MeasurementReviewOverview.css";

type Props = {
  site: Site; batches: MobileMeasurementBatch[]; state: MeasurementOverviewState;
  onState: (state: MeasurementOverviewState) => void;
  loading: boolean; error: string | null; message: string | null; actionError: string | null;
  archive: boolean; busy: boolean; canCreate: boolean;
  onToggleArchive: () => void; onRetry: () => void; onCreate: () => void;
  onOpen: (batch: MobileMeasurementBatch) => void;
  onExport: (batch: MobileMeasurementBatch, mode: "checked" | "original") => Promise<void>;
  canExport: (status: string) => boolean;
  title: (batch: MobileMeasurementBatch) => string;
  date: (value: string) => string; dateTime: (value: string) => string;
  renderStatus: (batch: MobileMeasurementBatch) => ReactNode;
  renderActions: (batch: MobileMeasurementBatch) => ReactNode;
};

export function MeasurementReviewOverview(props: Props) {
  const { site, batches, state, onState, loading, error, archive, title } = props;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(getExtraWorkOverviewMasterHeight(EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE));
  const [pdfAction, setPdfAction] = useState<string | null>(null);
  const pdfPending = useRef(false);
  const pageSize = calculateExtraWorkOverviewPageSize(height);
  const view = getMeasurementOverviewWindow(batches, state, pageSize, title);
  const selected = loading || error ? null : view.selected;
  const email = selected ? getCustomerEmailStatus(selected) : null;

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => setHeight(Math.max(getExtraWorkOverviewMasterHeight(EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE), Math.floor((window.visualViewport?.height ?? window.innerHeight) - workspace.getBoundingClientRect().top - 18)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace.parentElement!);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); };
  }, []);

  useLayoutEffect(() => {
    if (loading || error) return;
    if (state.page !== view.page || (state.selectedId !== view.selected?.id && (state.selectedId !== null || view.selected))) {
      onState({ ...state, selectedId: view.selected?.id ?? null, page: view.page });
    }
  }, [loading, error, state, view.selected, view.page, onState]);

  useLayoutEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected?.id]);

  async function exportPdf(batch: MobileMeasurementBatch, mode: "checked" | "original") {
    if (pdfPending.current) return;
    pdfPending.current = true;
    setPdfAction(`${batch.id}:${mode}`);
    try { await props.onExport(batch, mode); }
    catch { /* The existing parent export handler presents the error. */ }
    finally { pdfPending.current = false; setPdfAction(null); }
  }

  return <section className="measurement-overview">
    <header className="measurement-overview-toolbar">
      <div className="measurement-overview-toolbar-left">
        <h2><Ruler size={18} aria-hidden="true" />Prüfung</h2>
        <div className="measurement-overview-modes" role="group" aria-label="Aufmaßansicht">
          <button type="button" aria-pressed={!archive} disabled={loading || props.busy} onClick={() => archive && props.onToggleArchive()}>Aktiv</button>
          <span aria-hidden="true">·</span>
          <button type="button" aria-pressed={archive} disabled={loading || props.busy} onClick={() => !archive && props.onToggleArchive()}>Archiv</button>
        </div>
      </div>
      <div className="measurement-overview-toolbar-right">
        <label className="measurement-overview-search"><span className="sr-only">Aufmaße durchsuchen</span>
          <input type="search" placeholder="Suche…" value={state.query} onChange={(e) => onState({ selectedId: null, page: 1, query: e.target.value })} />
          <Search size={16} aria-hidden="true" />
        </label>
        {!archive && props.canCreate ? <button type="button" className="primary-action" disabled={loading || props.busy} onClick={props.onCreate}><Plus size={18} aria-hidden="true" />Aufmaß anlegen</button> : null}
      </div>
    </header>
    {props.message ? <div role="status" className="project-record-empty-state is-success">{props.message}</div> : null}
    {props.actionError ? <div role="alert" className="project-record-empty-state is-error">{props.actionError}</div> : null}
    <div className="measurement-overview-workspace" ref={workspaceRef} style={{ "--measurement-overview-height": `${height}px` } as CSSProperties}>
      <div className="measurement-overview-master">
        <div className="measurement-overview-list" role="region" aria-label="Aufmaßliste">
          <table><colgroup><col style={{width:"180px"}}/><col/><col style={{width:"104px"}}/><col style={{width:"104px"}}/><col style={{width:"104px"}}/></colgroup>
            <thead><tr>{["Status", "Titel / Nummer", "Datum", "Ersteller", "Umfang"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
            <tbody>
              {loading || error || view.visible.length === 0 ? <tr className="measurement-overview-state"><td colSpan={5}>
                {loading ? "Aufmaße werden geladen…" : error ? <><p role="alert">{error}</p><button type="button" className="secondary-action" onClick={props.onRetry}>Erneut laden</button></> : state.query.trim() ? "Keine Aufmaße gefunden" : archive ? "Keine archivierten Aufmaße vorhanden" : "Noch keine Aufmaße vorhanden"}
              </td></tr> : view.visible.map((batch) => {
                const creator = formatExtraWorkOverviewCreatorName(batch.created_by_name);
                const date = batch.measurement_date ?? batch.submitted_at;
                return <tr key={batch.id} className={selected?.id === batch.id ? "is-selected" : ""}
                  onClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("button, a, input")) onState({...state, selectedId:batch.id}); }}>
                  <td onClick={(e) => e.stopPropagation()}>{props.renderStatus(batch)}</td>
                  <td><button type="button" className="measurement-overview-select" aria-pressed={selected?.id === batch.id} onClick={() => onState({...state, selectedId:batch.id})}>{title(batch)}</button>
                    {batch.is_current_offer === false ? <span className="measurement-status is-old-offer" title={batch.offer_name ?? undefined}>Altes Angebot</span> : null}
                  </td>
                  <td title={batch.measurement_date ? "Aufmaßdatum" : "Einreichdatum"}>{date ? props.date(date) : "—"}</td>
                  <td title={creator.fullName || undefined}>{batch.created_by_name ? creator.shortName : "—"}</td>
                  <td className="measurement-overview-hours" title="Arbeitsstunden der Aufmaßpositionen laut hinterlegter Zeitkalkulation">
                    {formatMeasurementOverviewHours(batch.reported_hours)}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <footer className="measurement-overview-pagination">
          <span>{loading ? "Wird geladen…" : error ? "—" : formatMeasurementCount(view.filtered.length,"Aufmaß","Aufmaße")}</span>
          {!loading && !error && view.pageCount > 1 ? <nav aria-label="Seiten der Aufmaße">
            <button type="button" aria-label="Erste Seite" disabled={view.page===1} onClick={()=>onState({...state,page:1,selectedId:null})}>«</button>
            <button type="button" aria-label="Vorherige Seite" disabled={view.page===1} onClick={()=>onState({...state,page:view.page-1,selectedId:null})}>‹</button>
            {getExtraWorkOverviewPageItems(view.pageCount,view.page).map((page) => typeof page === "number" ? <button type="button" key={page} aria-current={page===view.page?"page":undefined} aria-label={`Seite ${page}`} onClick={()=>onState({...state,page,selectedId:null})}>{page}</button> : <span key={page}>…</span>)}
            <button type="button" aria-label="Nächste Seite" disabled={view.page===view.pageCount} onClick={()=>onState({...state,page:view.page+1,selectedId:null})}>›</button>
            <button type="button" aria-label="Letzte Seite" disabled={view.page===view.pageCount} onClick={()=>onState({...state,page:view.pageCount,selectedId:null})}>»</button>
          </nav> : null}
        </footer>
      </div>
      <aside className="measurement-overview-detail" ref={detailRef} aria-label={selected ? `Details zu ${title(selected)}` : "Aufmaßdetails"}>
        {!selected ? <p className="measurement-overview-empty">{loading ? "Aufmaße werden geladen…" : "Kein Aufmaß ausgewählt"}</p> : <>
          <header className="measurement-overview-detail-head"><h3>{title(selected)}</h3><div>
            <button type="button" className="secondary-action" disabled={archive || props.busy} title={archive ? "Aufmaß vor dem Öffnen wiederherstellen" : undefined} onClick={() => props.onOpen(selected)}>Öffnen</button>
            {props.renderActions(selected)}
          </div></header>
          <dl className="measurement-overview-meta">
            <div><dt>Einreicher</dt><dd>{selected.submitted_by_name || "Ohne Einreicher"}</dd></div>
            <div><dt>Eingereicht am</dt><dd>{selected.submitted_at ? props.dateTime(selected.submitted_at) : "—"}</dd></div>
            <div><dt>Zeilen</dt><dd>{selected.entry_count ?? "—"}</dd></div>
            <div><dt>Positionen</dt><dd>{selected.position_count ?? "—"}</dd></div>
          </dl>
          {selected.origin === "OFFICE" || selected.area_location || selected.assigned_employee_name || archive ? <p className="measurement-overview-origin">
            {selected.origin === "OFFICE" ? `Im Büro angelegt${selected.created_by_name ? ` · von ${selected.created_by_name}` : ""}` : null}
            {[selected.area_location,selected.assigned_employee_name].filter(Boolean).map(value=><span key={value}> · {value}</span>)}
            {archive ? <span> · Gelöscht {selected.deleted_at ? props.dateTime(selected.deleted_at) : "ohne Datum"}{selected.deleted_by_name ? ` · von ${selected.deleted_by_name}` : ""}</span> : null}
          </p> : null}
          <section><h4>Kunde &amp; Projekt</h4><dl className="measurement-overview-project">
            <div><dt>Kunde</dt><dd>{site.customer || "—"}</dd></div><div><dt>Projekt</dt><dd>{site.name}</dd></div><div><dt>Kom.-Nr.</dt><dd>{site.site_number || "—"}</dd></div>
          </dl></section>
          <section><h4>Versandstatus</h4><p className={`measurement-overview-delivery ${email!.className}`}>
            {email!.isSent ? <MailCheck size={19} aria-hidden="true"/> : <MailX size={19} aria-hidden="true"/>}{email!.label}
          </p></section>
          <section><h4>Dokumente</h4><div className="measurement-overview-documents">
            {(["checked", ...(selected.has_original_worker_submission ? ["original"] : [])] as const).map((mode) => <button type="button" key={mode}
              className="secondary-action" disabled={archive || !props.canExport(selected.status) || pdfAction !== null}
              title={archive ? "Aufmaß vor dem PDF-Export wiederherstellen" : props.canExport(selected.status) ? mode === "checked" ? "Geprüftes PDF mit Projektleiterkorrekturen exportieren" : "Originales Monteur-Aufmaß exportieren" : "PDF-Export erst nach Prüfung oder Abschluss verfügbar"}
              onClick={() => void exportPdf(selected,mode as "checked" | "original")}>
              <FileText size={18} aria-hidden="true"/>{pdfAction === `${selected.id}:${mode}` ? "PDF…" : mode === "checked" ? "Aufmaß geprüft" : "Originales Monteur-Aufmaß"}
            </button>)}
          </div></section>
        </>}
      </aside>
    </div>
  </section>;
}
