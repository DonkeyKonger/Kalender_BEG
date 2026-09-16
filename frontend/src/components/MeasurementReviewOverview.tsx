import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, MailCheck, MailX, Plus, Ruler, Search } from "lucide-react";
import type { MeasurementGroup, MobileMeasurementBatch, Site } from "../types/site";
import { getCustomerEmailStatus } from "../lib/customerEmailStatus";
import { calculateExtraWorkOverviewPageSize, EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE, formatExtraWorkOverviewCreatorName, getExtraWorkOverviewMasterHeight, getExtraWorkOverviewPageItems } from "../lib/extraWorkOverview";
import { formatMeasurementCount, formatMeasurementOverviewHours, formatMeasurementDetailHours, getMeasurementOverviewWindow, getMeasurementLocationPreviewCount, getMeasurementOfferDisplay } from "../lib/measurementReviewOverview";
import type { MeasurementOverviewState } from "../lib/measurementReviewOverview";
import { getMeasurementOverviewTitle } from "../lib/measurementReviewOverview";
import { getMeasurementGroups, isMeasurementCompleted } from "../lib/measurementReviewOverview";
import "./MeasurementReviewOverview.css";

type Props = {
  site: Site; batches: MobileMeasurementBatch[]; state: MeasurementOverviewState;
  onState: (state: MeasurementOverviewState) => void;
  loading: boolean; error: string | null; message: string | null; actionError: string | null;
  archive: boolean; busy: boolean; canCreate: boolean;
  switchingArchive?: boolean;
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
  onCombine?: (ids: number[]) => Promise<MeasurementGroup>;
  onExportGroup?: (group: MeasurementGroup) => Promise<void>;
};

export function MeasurementReviewOverview(props: Props) {
  const { site, batches, state, onState, loading, error, archive } = props;
  const title = (batch: MobileMeasurementBatch) => getMeasurementOverviewTitle(batch, props.title(batch));
  const workspaceRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(getExtraWorkOverviewMasterHeight(EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE));
  const [pdfAction, setPdfAction] = useState<string | null>(null);
  const pdfPending = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [combining, setCombining] = useState(false);
  const combinePending = useRef(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupMessage, setGroupMessage] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const pageSize = calculateExtraWorkOverviewPageSize(height);
  const view = getMeasurementOverviewWindow(batches, state, pageSize, title);
  const currentGroups = getMeasurementGroups(batches);
  const eligible = batches.filter(batch => isMeasurementCompleted(batch) && !currentGroups.has(batch.combined_measurement?.id ?? -1));
  const chosenBatches = eligible.filter(batch => chosen.includes(batch.id));
  const selectedGroup = !loading && !error && !archive && view.visible.some(batch => batch.combined_measurement?.id === selectedGroupId)
    ? view.groups.get(selectedGroupId!) : undefined;
  const busy = props.busy || combining;
  const changeState = (next: MeasurementOverviewState) => { setSelectedGroupId(null); onState(next); };
  const selected = loading || error ? null : view.selected;
  const email = selected ? getCustomerEmailStatus(selected) : null;
  const selectedOffer = selected ? getMeasurementOfferDisplay(selected) : null;

  useEffect(() => { setChoosing(false); setChosen([]); setConfirming(false); setSelectedGroupId(null); setGroupMessage(null); setGroupError(null); }, [archive, site.id]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => setHeight(Math.max(280, Math.floor((window.visualViewport?.height ?? window.innerHeight) - (workspace.getBoundingClientRect().top + window.scrollY) - 18)));
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

  useLayoutEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected?.id, selectedGroup?.id]);

  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (!detail) return;
    const update = () => {
      const style = window.getComputedStyle(detail);
      const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const scrollbar = Math.max(0, detail.offsetWidth - detail.clientWidth - border);
      detail.style.setProperty("--measurement-overview-detail-scrollbar", `${scrollbar}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(detail);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      detail.style.removeProperty("--measurement-overview-detail-scrollbar");
    };
  }, []);

  async function exportPdf(batch: MobileMeasurementBatch) {
    if (pdfPending.current) return;
    pdfPending.current = true;
    setPdfAction(`${batch.id}`);
    // The checked export uses current entries, not the original submission snapshot.
    try { await props.onExport(batch, "checked"); }
    catch { /* The existing parent export handler presents the error. */ }
    finally { pdfPending.current = false; setPdfAction(null); }
  }

  async function combine() {
    if (!props.onCombine || combinePending.current || chosenBatches.length < 2) return;
    combinePending.current = true; setCombining(true); setGroupError(null);
    try {
      const group = await props.onCombine(chosenBatches.map(batch => batch.id));
      setConfirming(false); setChoosing(false); setChosen([]); setSelectedGroupId(group.id);
      onState({ ...state, query: "", page: 1, selectedId: group.sources[0].id });
      setGroupMessage(`Gesamtaufmaß ${group.number_label} erstellt.`);
    } catch (error) { setGroupError(error instanceof Error ? error.message : "Zusammenfassen fehlgeschlagen."); }
    finally { combinePending.current = false; setCombining(false); }
  }

  async function exportGroup(group: MeasurementGroup) {
    if (!props.onExportGroup || pdfPending.current) return;
    pdfPending.current = true; setPdfAction(`group:${group.id}`); setGroupError(null);
    try { await props.onExportGroup(group); }
    catch (error) { setGroupError(error instanceof Error ? error.message : "PDF konnte nicht geladen werden."); props.onRetry(); }
    finally { pdfPending.current = false; setPdfAction(null); }
  }

  return <section className="measurement-overview" aria-busy={loading || props.switchingArchive || false}>
    <header className="measurement-overview-toolbar">
      <div className="measurement-overview-toolbar-left">
        <h2><Ruler size={18} aria-hidden="true" />Prüfung</h2>
        <div className="measurement-overview-modes" role="group" aria-label="Aufmaßansicht">
          <button type="button" aria-pressed={!archive} disabled={loading || busy} onClick={() => archive && props.onToggleArchive()}>Aktiv</button>
          <span aria-hidden="true">·</span>
          <button type="button" aria-pressed={archive} disabled={loading || busy} onClick={() => !archive && props.onToggleArchive()}>Archiv</button>
        </div>
      </div>
      <div className="measurement-overview-toolbar-right">
        <label className="measurement-overview-search"><span className="sr-only">Aufmaße durchsuchen</span>
          <input type="search" placeholder="Suche…" disabled={props.switchingArchive || combining} value={state.query} onChange={(e) => changeState({ selectedId: null, page: 1, query: e.target.value })} />
          <Search size={16} aria-hidden="true" />
        </label>
        {!archive && props.onCombine ? <button type="button" className="secondary-action measurement-group-toggle" aria-pressed={choosing} disabled={loading || busy} onClick={() => { setChoosing(!choosing); setChosen([]); setGroupError(null); setGroupMessage(null); }}>Aufmaße zusammenfassen</button> : null}
        {!archive && props.canCreate ? <button type="button" className="primary-action" disabled={loading || busy} onClick={props.onCreate}><Plus size={18} aria-hidden="true" />Aufmaß anlegen</button> : props.canCreate ? <span className="measurement-overview-create-placeholder" aria-hidden="true" /> : null}
      </div>
    </header>
    {choosing && !archive ? <div className="measurement-group-selection">
      <span>{chosenBatches.length} ausgewählt · Nur abgeschlossene Aufmaße</span>
      <button type="button" className="secondary-action" disabled={busy} onClick={() => { setChoosing(false); setChosen([]); }}>Abbrechen</button>
      <button type="button" className="primary-action" disabled={busy || chosenBatches.length < 2} onClick={() => setConfirming(true)}>Auswahl zusammenfassen</button>
    </div> : null}
    {groupMessage ? <p role="status" className="measurement-group-message">{groupMessage}</p> : null}
    {groupError && !confirming ? <p role="alert" className="project-record-empty-state is-error">{groupError}</p> : null}
    <div role="status" className="sr-only">{props.message ?? ""}</div>
    {props.actionError ? <div role="alert" className="project-record-empty-state is-error">{props.actionError}</div> : null}
    <div className="measurement-overview-workspace" ref={workspaceRef} style={{ "--measurement-overview-height": `${height}px`, "--measurement-overview-master-height": `${getExtraWorkOverviewMasterHeight(pageSize)}px` } as CSSProperties}>
      <div className="measurement-overview-master" inert={props.switchingArchive || undefined}>
        <div className="measurement-overview-list" role="region" aria-label="Aufmaßliste">
          <table><colgroup><col className="measurement-overview-status-col"/><col/><col className="measurement-overview-invoiced-col"/><col className="measurement-overview-date-col"/><col className="measurement-overview-creator-col"/><col className="measurement-overview-hours-col"/></colgroup>
            <thead><tr>{["Status", "Titel / Nummer", "Abgerechnet", "Datum", "Ersteller", "Umfang"].map((label) => <th key={label} scope="col" className={label === "Umfang" ? "measurement-overview-hours" : undefined}>{label}</th>)}</tr></thead>
            <tbody>
              {loading || error || view.visible.length === 0 ? <tr className="measurement-overview-state"><td colSpan={6}>
                {loading ? "Aufmaße werden geladen…" : error ? <><p role="alert">{error}</p><button type="button" className="secondary-action" onClick={props.onRetry}>Erneut laden</button></> : state.query.trim() ? "Keine Aufmaße gefunden" : archive ? "Keine archivierten Aufmaße vorhanden" : "Noch keine Aufmaße vorhanden"}
              </td></tr> : view.visible.map((batch, index) => {
                const creator = formatExtraWorkOverviewCreatorName(batch.created_by_name);
                const date = batch.measurement_date ?? batch.submitted_at;
                const offer = getMeasurementOfferDisplay(batch);
                const group = view.groups.get(batch.combined_measurement?.id ?? -1);
                const showHeader = group && view.visible[index - 1]?.combined_measurement?.id !== group.id;
                return <Fragment key={batch.id}>
                  {showHeader ? <tr className={`measurement-group-header ${selectedGroup?.id === group.id ? "is-selected" : ""}`}><td colSpan={6}>
                    <button type="button" aria-pressed={selectedGroup?.id === group.id} onClick={() => { setSelectedGroupId(group.id); onState({ ...state, selectedId: batch.id }); }}>
                      <span>Gesamtaufmaß {group.number_label}</span><small>{group.sources.length} Aufmaße</small>
                    </button>
                  </td></tr> : null}
                  <tr className={`${!selectedGroup && selected?.id === batch.id ? "is-selected" : ""} ${group ? "measurement-group-child" : ""}`}
                  onClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("button, a, input")) changeState({...state, selectedId:batch.id}); }}>
                  <td onClick={(e) => e.stopPropagation()}><div className="measurement-group-status">
                    {choosing ? <input type="checkbox" className="measurement-group-checkbox" aria-label={`${title(batch)} auswählen`}
                      title={group ? "Bereits zusammengefasst" : !isMeasurementCompleted(batch) ? "Nur abgeschlossene Aufmaße" : "Für Gesamtaufmaß auswählen"}
                      disabled={busy || Boolean(group) || !isMeasurementCompleted(batch)} checked={chosenBatches.some(row => row.id === batch.id)}
                      onChange={event => setChosen(current => event.target.checked ? [...current, batch.id] : current.filter(id => id !== batch.id))} /> : null}
                    {props.renderStatus(batch)}</div></td>
                  <td><button type="button" className="measurement-overview-select" aria-pressed={!selectedGroup && selected?.id === batch.id} onClick={() => changeState({...state, selectedId:batch.id})}>{title(batch)}</button>
                    {offer.kind === "older" ? <span className="measurement-status is-old-offer" title={offer.name}>Altes Angebot</span> : null}
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
                </tr></Fragment>;
              })}
            </tbody>
          </table>
        </div>
        <footer className="measurement-overview-pagination">
          <span>{loading ? "Wird geladen…" : error ? "—" : formatMeasurementCount(view.filtered.length,"Aufmaß","Aufmaße")}</span>
          {!loading && !error && view.pageCount > 1 ? <nav aria-label="Seiten der Aufmaße">
            <button type="button" aria-label="Erste Seite" disabled={view.page===1} onClick={()=>changeState({...state,page:1,selectedId:null})}>«</button>
            <button type="button" aria-label="Vorherige Seite" disabled={view.page===1} onClick={()=>changeState({...state,page:view.page-1,selectedId:null})}>‹</button>
            {getExtraWorkOverviewPageItems(view.pageCount,view.page).map((page) => typeof page === "number" ? <button type="button" key={page} aria-current={page===view.page?"page":undefined} aria-label={`Seite ${page}`} onClick={()=>changeState({...state,page,selectedId:null})}>{page}</button> : <span key={page}>…</span>)}
            <button type="button" aria-label="Nächste Seite" disabled={view.page===view.pageCount} onClick={()=>changeState({...state,page:view.page+1,selectedId:null})}>›</button>
            <button type="button" aria-label="Letzte Seite" disabled={view.page===view.pageCount} onClick={()=>changeState({...state,page:view.pageCount,selectedId:null})}>»</button>
          </nav> : null}
        </footer>
      </div>
      <aside className="measurement-overview-detail" ref={detailRef} inert={props.switchingArchive || undefined} aria-label={selectedGroup ? `Details zu Gesamtaufmaß ${selectedGroup.number_label}` : selected ? `Details zu ${title(selected)}` : "Aufmaßdetails"}>
        {selectedGroup ? <>
          <header className="measurement-overview-detail-head measurement-group-detail-head"><h3>Gesamtaufmaß {selectedGroup.number_label}</h3>
            <button type="button" className="secondary-action" disabled={busy || pdfAction !== null || !props.onExportGroup} onClick={() => void exportGroup(selectedGroup)}>{pdfAction ? "PDF…" : "PDF herunterladen"}</button>
          </header>
          <section><h4>Fester Gesamtstand</h4><p className="measurement-group-explanation">Die Mengen der enthaltenen Aufmaße sind gemeinsam zusammengefasst. Änderungen an einem Einzelaufmaß lösen diese Zusammenfassung automatisch auf.</p>
            <dl className="measurement-group-meta"><div><dt>Erstellt</dt><dd>{props.dateTime(selectedGroup.created_at)}</dd></div><div><dt>Positionen</dt><dd>{selectedGroup.position_count}</dd></div></dl>
          </section>
          <section><h4>Enthaltene Aufmaße</h4><ul className="measurement-group-sources">{selectedGroup.sources.map(source => <li key={source.id}><button type="button" onClick={() => changeState({ ...state, selectedId: source.id })}>Aufmaß {source.number_label}</button></li>)}</ul></section>
          <section><h4>Übernommene Unterschriften</h4><p className="measurement-group-explanation">{selectedGroup.worker_signature_count} Monteursunterschriften<br />{selectedGroup.has_customer_signature ? `Kundenunterschrift aus Aufmaß ${selectedGroup.sources[0].number_label} (in allen Einzelaufmaßen vorhanden)` : "Keine Kundenunterschrift – nicht in allen Einzelaufmaßen vorhanden"}</p></section>
        </> : !selected ? <p className="measurement-overview-empty">{loading ? "Aufmaße werden geladen…" : "Kein Aufmaß ausgewählt"}</p> : <>
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
            {[selected.origin !== "OFFICE" ? selected.area_location : null,selected.assigned_employee_name].filter(Boolean).map(value=><span key={value}> · {value}</span>)}
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
          <section className="measurement-overview-offer" aria-label="Zugeordnetes Angebot">
            <h4>Zugeordnetes Angebot</h4>
            <p className="measurement-overview-offer-name">{selectedOffer!.name}</p>
          </section>
          <MeasurementMountingLocations key={selected.id} locations={selected.mounting_locations ?? []} />
          {props.renderPhotos?.(selected)}
        </>}
      </aside>
      {props.switchingArchive ? <div className="measurement-overview-switch-pending" role="status">
        <span>{archive ? "Aktive Aufmaße werden geladen…" : "Archiv wird geladen…"}</span>
      </div> : null}
    </div>
    {confirming ? <MeasurementGroupConfirmation batches={chosenBatches} title={title} busy={combining} error={groupError}
      onCancel={() => { if (!combining) { setConfirming(false); setGroupError(null); } }} onConfirm={() => void combine()} /> : null}
  </section>;
}

function MeasurementGroupConfirmation({ batches, title, busy, error, onCancel, onConfirm }: {
  batches: MobileMeasurementBatch[]; title: (batch: MobileMeasurementBatch) => string;
  busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="measurement-group-dialog" aria-labelledby="measurement-group-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h3 id="measurement-group-dialog-title">Aufmaße zusammenfassen?</h3>
    <p>Es wird ein fester Gesamtstand erstellt. Die Einzelaufmaße bleiben erhalten. Sobald eines davon geändert wird, wird die Zusammenfassung wieder entfernt.</p>
    <ul>{batches.map(batch => <li key={batch.id}>{title(batch)}{batch.is_invoiced ? " · bereits abgerechnet" : ""}</li>)}</ul>
    <p>Vorhandene Monteursunterschriften werden übernommen. Die Kundenunterschrift des Aufmaßes mit der höchsten Nummer wird nur übernommen, wenn alle ausgewählten Aufmaße eine Kundenunterschrift haben.</p>
    {error ? <p role="alert" className="is-error">{error}</p> : null}
    <footer><button autoFocus type="button" className="secondary-action" disabled={busy} onClick={onCancel}>Abbrechen</button><button type="button" className="primary-action" disabled={busy || batches.length < 2} onClick={onConfirm}>{busy ? "Wird erstellt…" : `${batches.length} Aufmaße zusammenfassen`}</button></footer>
  </dialog>;
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
