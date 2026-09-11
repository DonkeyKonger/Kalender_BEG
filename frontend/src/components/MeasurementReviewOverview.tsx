import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, MailCheck, MailX, Plus, Ruler, Search } from "lucide-react";
import type { MobileMeasurementBatch, Site } from "../types/site";
import { getCustomerEmailStatus } from "../lib/customerEmailStatus";
import { calculateExtraWorkOverviewPageSize, EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE, EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE, formatExtraWorkOverviewCreatorName, getExtraWorkOverviewMasterHeight, getExtraWorkOverviewPageItems } from "../lib/extraWorkOverview";
import { formatMeasurementCount, formatMeasurementOverviewHours, formatMeasurementDetailHours, getMeasurementOverviewWindow, getMeasurementLocationPreviewCount } from "../lib/measurementReviewOverview";
import type { MeasurementOverviewState } from "../lib/measurementReviewOverview";
import "./MeasurementReviewOverview.css";

type Props = {
  site: Site; batches: MobileMeasurementBatch[]; state: MeasurementOverviewState;
  onState: (state: MeasurementOverviewState) => void;
  loading: boolean; error: string | null; message: string | null; actionError: string | null;
  archive: boolean; busy: boolean; canCreate: boolean;
  canMarkInvoiced: boolean;
  onToggleInvoiced: (batch: MobileMeasurementBatch) => void;
  onToggleArchive: () => void; onRetry: () => void; onCreate: () => void;
  onOpen: (batch: MobileMeasurementBatch) => void;
  onExport: (batch: MobileMeasurementBatch, mode: "checked" | "original") => Promise<void>;
  canExport: (status: string) => boolean;
  title: (batch: MobileMeasurementBatch) => string;
  date: (value: string) => string; dateTime: (value: string) => string;
  renderStatus: (batch: MobileMeasurementBatch) => ReactNode;
  renderActions: (batch: MobileMeasurementBatch) => ReactNode;
  renderPhotos?: (batch: MobileMeasurementBatch) => ReactNode;
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

  async function exportPdf(batch: MobileMeasurementBatch) {
    if (pdfPending.current) return;
    pdfPending.current = true;
    setPdfAction(`${batch.id}`);
    // The checked export uses current entries, not the original submission snapshot.
    try { await props.onExport(batch, "checked"); }
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
    <div role="status" className="sr-only">{props.message ?? ""}</div>
    {props.actionError ? <div role="alert" className="project-record-empty-state is-error">{props.actionError}</div> : null}
    <div className="measurement-overview-workspace" ref={workspaceRef} style={{ "--measurement-overview-height": `${height}px` } as CSSProperties}>
      <div className="measurement-overview-master">
        <div className="measurement-overview-list" role="region" aria-label="Aufmaßliste">
          <table><colgroup><col style={{width:"180px"}}/><col/><col style={{width:"104px"}}/><col style={{width:"104px"}}/><col style={{width:"104px"}}/><col style={{width:"104px"}}/></colgroup>
            <thead><tr>{["Status", "Titel / Nummer", "Abgerechnet", "Datum", "Ersteller", "Umfang"].map((label) => <th key={label} scope="col" className={label === "Umfang" ? "measurement-overview-hours" : undefined}>{label}</th>)}</tr></thead>
            <tbody>
              {loading || error || view.visible.length === 0 ? <tr className="measurement-overview-state"><td colSpan={6}>
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
                  <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <label className="project-extra-work-invoiced-control measurement-overview-invoiced" title={batch.is_invoiced ? "Abrechnungsmarkierung entfernen – Aufmaß bleibt abgeschlossen" : "Als abgerechnet markieren und Aufmaß abschließen"}>
                      <input type="checkbox" checked={batch.is_invoiced === true}
                        disabled={!props.canMarkInvoiced || archive || props.busy || loading}
                        aria-label={`${title(batch)}: ${batch.is_invoiced ? "Abrechnungsmarkierung entfernen" : "Als abgerechnet markieren"}`}
                        onChange={() => props.onToggleInvoiced(batch)} />
                      <span className="project-extra-work-invoiced-box" aria-hidden="true">{batch.is_invoiced ? <Check size={14} strokeWidth={3} /> : null}</span>
                    </label>
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
            <button type="button" className="secondary-action measurement-overview-pdf"
              disabled={archive || props.busy || !props.canExport(selected.status) || pdfAction !== null}
              title={archive ? "Aufmaß vor dem PDF-Export wiederherstellen" : props.canExport(selected.status) ? "Aktuellen Aufmaßstand als PDF herunterladen" : "PDF-Export erst nach Prüfung oder Abschluss verfügbar"}
              aria-label={`${title(selected)}: aktuellen Stand als PDF herunterladen`} aria-busy={pdfAction === `${selected.id}`}
              onClick={() => void exportPdf(selected)}>{pdfAction === `${selected.id}` ? "PDF…" : "PDF"}</button>
            {props.renderActions(selected)}
          </div></header>
          <dl className="measurement-overview-meta">
            <div><dt>Einreicher</dt><dd>{selected.submitted_by_name || "Ohne Einreicher"}</dd></div>
            <div><dt>Eingereicht am</dt><dd>{selected.submitted_at ? props.dateTime(selected.submitted_at) : "—"}</dd></div>
            <div><dt>Positionen</dt><dd>{selected.position_count ?? "—"}</dd></div>
            <div><dt>Gesamtstunden</dt><dd>{formatMeasurementDetailHours(selected.reported_hours)}</dd></div>
          </dl>
          {selected.origin === "OFFICE" || selected.area_location || selected.assigned_employee_name || archive ? <p className="measurement-overview-origin">
            {selected.origin === "OFFICE" ? `Im Büro angelegt${selected.created_by_name ? ` · von ${selected.created_by_name}` : ""}` : null}
            {[selected.area_location,selected.assigned_employee_name].filter(Boolean).map(value=><span key={value}> · {value}</span>)}
            {archive ? <span> · Gelöscht {selected.deleted_at ? props.dateTime(selected.deleted_at) : "ohne Datum"}{selected.deleted_by_name ? ` · von ${selected.deleted_by_name}` : ""}</span> : null}
          </p> : null}
          <section><h4>Kunde &amp; Projekt</h4><dl className="measurement-overview-project">
            <div><dt>Kunde</dt><dd>{site.customer || "—"}</dd></div><div><dt>Projekt</dt><dd>{site.name}</dd></div><div><dt>Kom.-Nr.</dt><dd>{site.site_number || "—"}</dd></div>
            <div className="project-extra-work-delivery-field"><dt>Versandstatus</dt><dd>
              <span className={`project-extra-work-delivery-status ${email!.className}`} role="img" tabIndex={0}
                aria-label={email!.accessibleLabel} aria-describedby={`measurement-delivery-status-${selected.id}`}>
                {email!.isSent ? <MailCheck size={19} aria-hidden="true"/> : <MailX size={19} aria-hidden="true"/>}
                <span className="project-extra-work-delivery-tooltip" id={`measurement-delivery-status-${selected.id}`} role="tooltip">{email!.accessibleLabel}</span>
              </span>
            </dd></div>
          </dl></section>
          <MeasurementMountingLocations key={selected.id} locations={selected.mounting_locations ?? []} />
          {props.renderPhotos?.(selected)}
        </>}
      </aside>
    </div>
  </section>;
}

function MeasurementMountingLocations({ locations }: { locations: string[] }) {
  const measureRef = useRef<HTMLUListElement>(null);
  const [visibleCount, setVisibleCount] = useState(locations.length);
  useLayoutEffect(() => {
    const list = measureRef.current;
    if (!list) return;
    const measure = () => {
      if (list.getBoundingClientRect().width === 0) return;
      setVisibleCount(getMeasurementLocationPreviewCount(
        Array.from(list.children, item => item.getBoundingClientRect().top),
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    // Font changes can alter the wrapping even when the total list height stays equal.
    Array.from(list.children).forEach(item => observer.observe(item));
    return () => observer.disconnect();
  }, [locations]);
  const remaining = locations.slice(visibleCount);
  return <section className="measurement-overview-locations">
    <h4>Montageorte{locations.length > 0 ? <span className="measurement-overview-location-count">{locations.length}</span> : null}</h4>
    {locations.length === 0 ? <p className="measurement-overview-locations-empty">Keine Montageorte eingetragen</p> : <>
      <div className="measurement-overview-location-preview">
        <ul className="measurement-overview-location-list" aria-label="Montageorte">
          {locations.slice(0, visibleCount).map(location => <li key={location} title={location}>{location}</li>)}
        </ul>
        <ul ref={measureRef} className="measurement-overview-location-list measurement-overview-location-measure" aria-hidden="true">
          {locations.map(location => <li key={location}>{location}</li>)}
        </ul>
      </div>
      {remaining.length > 0 ? <details className="measurement-overview-locations-more">
        <summary><span className="when-closed">+ {remaining.length} weitere anzeigen</span><span className="when-open">Weniger anzeigen</span></summary>
        <div className="measurement-overview-locations-scroll" tabIndex={0} role="region" aria-label="Weitere Montageorte">
          <ul className="measurement-overview-location-list">{remaining.map(location => <li key={location}>{location}</li>)}</ul>
        </div>
      </details> : null}
    </>}
  </section>;
}
