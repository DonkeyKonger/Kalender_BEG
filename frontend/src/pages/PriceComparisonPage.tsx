import {
  Calculator,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderSync,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MapFilterSelect } from "../components/MapFilterSelect";
import { uploadPriceFiles, validateOfferFiles } from "../priceComparison/uploads";
import { getPriceChartDomain } from "../priceComparison/chartDomain";
import { getPriceChartDateLabels, getPriceChartLayout, getPriceChartWindow } from "../priceComparison/chartLayout";
import {
  PriceComparisonError,
  type ArticleDetailResult,
  type FilesResult,
  type OfferPositionsResult,
  type OffersResult,
  type OfferType,
  type PriceComparisonStatus,
  type PriceFile,
  type ReferenceArticle,
  type ReferencePresets,
  type RebuildPreview,
  type SuggestionResult,
  type TableResult,
  priceDownload,
  priceRequest,
  queryPath,
  triggerDownload,
} from "../priceComparison/client";
import {
  type ArticleSearchIndex,
  searchArticleIndex,
  useArticleSearchIndex,
} from "../priceComparison/articleSearch";
import { articleWeightLabel, summarizeArticleDescription } from "../priceComparison/articleSummary";
import "../priceComparison/priceComparison.css";

type ViewKey = "datanorm" | "offers" | "articles" | "files";
type PriceTableVariant = "datanorm" | "suggestions" | "offer" | "article" | "generic";
type DuplicateOffer = { offer_number: string; keep: string; remove: string };
type UploadDuplicatePreview = {
  kind: PriceFile["kind"];
  files: File[];
  duplicates: DuplicateOffer[];
  revision: string;
  message?: string;
};

const views: Array<{ key: ViewKey; label: string }> = [
  { key: "articles", label: "Artikelvergleich" },
  { key: "offers", label: "Angebote OBO" },
  { key: "datanorm", label: "Nettopreisabgleich" },
  { key: "files", label: "Dateien" },
];

const articleHistoryColumnWidths: Record<string, string> = {
  Datum: "88px",
  Preis: "105px",
  Menge: "75px",
  Angebot: "120px",
  Angebotsart: "160px",
  "Gesamt (netto)": "120px",
};

const offerTypes: OfferType[] = ["Erstangebot", "Folgeangebot", "Verhandeltes Angebot"];
const offerTypeFilterOptions = [
  { value: "", label: "Alle Angebotsarten" },
  ...offerTypes.map((type) => ({ value: type, label: type })),
];
const currencyFormatter = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const percentFormatter = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const integerFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const chartPriceFormatters = Array.from({ length: 7 }, (_, digits) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const decimalFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });
const dateFormatter = new Intl.DateTimeFormat("de-DE");
const shortDateFormatter = new Intl.DateTimeFormat("de-DE", { month: "2-digit", year: "2-digit" });
const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" });

export function PriceComparisonPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view") as ViewKey | null;
  const activeView = views.some((view) => view.key === requestedView) ? requestedView! : "articles";
  const [status, setStatus] = useState<PriceComparisonStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [uploadBlockReason, setUploadBlockReason] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingOperations, setPendingOperations] = useState(0);
  const onOperation = useCallback((started: boolean) => {
    setPendingOperations((count) => Math.max(0, count + (started ? 1 : -1)));
  }, []);
  const [uploadRevision, setUploadRevision] = useState<string | null>(null);
  const articleSearch = useArticleSearchIndex(user?.id ?? null);
  const statusRequest = useRef(0);
  const statusController = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    const requestId = ++statusRequest.current;
    setIsStatusLoading(true);
    setStatusError(null);
    try {
      const loaded = await priceRequest<PriceComparisonStatus>("/price-comparison/status", { signal: controller.signal });
      if (requestId === statusRequest.current) setStatus(loaded);
    } catch (error) {
      if (requestId === statusRequest.current && !isAbortError(error)) setStatusError(errorMessage(error));
    } finally {
      if (requestId === statusRequest.current) setIsStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => {
      statusController.current?.abort();
      statusRequest.current += 1;
    };
  }, [loadStatus]);

  const syncStatusFromFiles = useCallback((files: FilesResult) => {
    statusController.current?.abort();
    statusRequest.current += 1;
    if (!status) {
      void loadStatus();
      return;
    }
    setIsStatusLoading(false);
    setStatusError(null);
    setStatus({
      ...status,
      offer_count: files.files.filter((file) => file.kind === "offers" && file.included_in_comparison !== false).length,
      datanorm_count: files.files.filter((file) => file.kind === "datanorm").length,
      active_datanorm: files.files.find((file) => file.kind === "datanorm" && file.active)?.name ?? null,
      revision: files.revision,
    });
  }, [loadStatus, status]);

  function selectView(view: ViewKey) {
    const next = new URLSearchParams(searchParams);
    if (view === "articles") next.delete("view");
    else next.set("view", view);
    setSearchParams(next);
  }

  return (
    <section className={`price-comparison-page page-stack${activeView === "offers" ? " is-offers-view" : ""}`}>
      <header className="price-comparison-header">
        <div>
          <p className="eyebrow">Einkauf & Kalkulation</p>
          <h1>Preisvergleich</h1>
          <p className="price-comparison-intro">
            Datanorm-Preise, Projektangebote und Preisverläufe in einer gemeinsamen Arbeitsansicht.
          </p>
        </div>
        <HeaderOfferUpload disabled={isStatusLoading || !status?.configured || Boolean(uploadBlockReason) || pendingOperations > 0} blockReason={pendingOperations ? "Ein Dateivorgang wird abgeschlossen …" : uploadBlockReason} onBusyChange={setUploading} onUploaded={(revision) => {
          setUploadRevision(revision);
          void loadStatus();
        }} />
      </header>

      {statusError ? <InlineNotice tone="error" action={<RetryButton onClick={loadStatus} />}>{statusError}</InlineNotice> : null}
      {status && !status.configured ? (
        <InlineNotice tone="info">
          {status.mode === "onedrive"
            ? "Die OneDrive-Anbindung für den Preisvergleich ist noch nicht eingerichtet. Bitte lassen Sie die Kalenderkonfiguration durch einen Administrator vervollständigen."
            : "Der lokale Preisvergleich ist noch nicht eingerichtet. Nach der Einrichtung können im Bereich „Dateien“ PDF-Angebote und eine Datanorm hochgeladen werden."}
        </InlineNotice>
      ) : null}

      <div className="price-view-tabs" role="tablist" aria-label="Preisvergleich Bereiche">
        {views.map((view) => (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={activeView === view.key}
            className={activeView === view.key ? "is-active" : undefined}
            onClick={() => selectView(view.key)}
          >
            {view.label}
          </button>
        ))}
      </div>

      <div className="price-view-content" role="tabpanel">
        {activeView === "datanorm" ? <DatanormView onOperation={onOperation} uploadRevision={uploadRevision} uploading={uploading} /> : null}
        {activeView === "offers" ? <OffersView onOperation={onOperation} uploadRevision={uploadRevision} uploading={uploading} onUploadBlock={setUploadBlockReason} /> : null}
        {activeView === "articles" ? <ArticlesView articleSearch={articleSearch} uploadRevision={uploadRevision} /> : null}
        {activeView === "files" ? <FilesView onOperation={onOperation} uploading={uploading} uploadRevision={uploadRevision} status={status} onMutation={syncStatusFromFiles} /> : null}
      </div>
    </section>
  );
}

function HeaderOfferUpload({ disabled, blockReason, onBusyChange, onUploaded }: { disabled: boolean; blockReason: string | null; onBusyChange: (busy: boolean) => void; onUploaded: (revision: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UploadDuplicatePreview | null>(null);
  const hintId = useId();
  const locked = disabled || busy || Boolean(preview);

  async function upload(files: File[], confirmation?: UploadDuplicatePreview) {
    if (busyRef.current || disabled || (!confirmation && preview)) return;
    setError(null);
    setMessage(null);
    const invalid = validateOfferFiles(files);
    if (invalid) { setError(invalid); return; }
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    try {
      // Read a current revision before upload; the server still checks it atomically.
      const revision = confirmation?.revision ?? (await priceRequest<FilesResult>("/price-comparison/files")).revision;
      const result = await uploadPriceFiles("offers", files, revision, confirmation?.duplicates.map((duplicate) => duplicate.remove));
      setPreview(null);
      setMessage("Angebote erfolgreich hochgeladen.");
      onUploaded(result.revision);
    } catch (uploadError) {
      const duplicateDetail = duplicateUploadDetail(uploadError);
      if (duplicateDetail) setPreview({ kind: "offers", files, ...duplicateDetail });
      else {
        setPreview(null);
        setError(mutationErrorMessage(uploadError));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="price-header-upload">
      <input ref={inputRef} className="sr-only" type="file" accept="application/pdf,.pdf" multiple tabIndex={-1} aria-label="Angebots-PDFs auswählen" disabled={locked} onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) void upload(files);
      }} />
      <button type="button" className={`price-offer-dropzone${dragging ? " is-dragging" : ""}`} aria-disabled={locked} aria-busy={busy} aria-describedby={hintId}
        onClick={() => { if (!locked) inputRef.current?.click(); }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          if (!locked) setDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = locked ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!locked) {
            const files = Array.from(event.dataTransfer.files);
            if (files.length) void upload(files);
          }
        }}>
        <span className="price-upload-icon" aria-hidden="true">{busy ? <LoaderCircle className="is-spinning" size={22} /> : <Upload size={22} />}</span>
        <span><strong>{busy ? "Angebote werden hochgeladen …" : dragging ? "Angebote hier ablegen" : "Angebote hochladen"}</strong><span id={hintId}>{busy ? "Sie können währenddessen den Tab wechseln." : blockReason || "PDFs hierher ziehen oder Dateien auswählen"}</span></span>
      </button>
      <div className="price-upload-feedback" aria-live="polite" aria-atomic="true">
        {error ? <p className="is-error">{error}</p> : message ? <p className="is-success"><Check size={14} aria-hidden="true" />{message}</p> : null}
      </div>
      {preview ? <UploadDuplicateDialog preview={preview} busy={busy} onClose={() => setPreview(null)} onConfirm={() => void upload(preview.files, preview)} /> : null}
    </div>
  );
}

function UploadDuplicateDialog({ preview, busy, onClose, onConfirm }: { preview: UploadDuplicatePreview; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  return (
    <div className="price-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (!busy && event.currentTarget === event.target) onClose();
    }}>
      <section ref={dialogRef} className="price-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
        if (event.key === "Tab") {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
        }
      }}>
        <header><div><span className="price-kicker">Bestätigung erforderlich</span><h3 id={titleId}>{preview.kind === "offers" ? "Vorhandene Angebote ersetzen" : "Vorhandene Datanorm ersetzen"}</h3></div><button className="price-icon-button" type="button" aria-label="Dialog schließen" disabled={busy} onClick={onClose}><X size={18} /></button></header>
        <p>{preview.message || (preview.kind === "offers" ? "Die hochgeladenen Dateien enthalten bereits vorhandene Angebotsnummern. Die neuen Dateien bleiben erhalten; die aufgeführten älteren Dateien werden nur nach Ihrer Bestätigung gelöscht." : "Eine Datanorm-Datei mit diesem Namen ist bereits vorhanden und wird nur nach Ihrer Bestätigung ersetzt.")}</p>
        <div className="duplicate-preview-list">{preview.duplicates.map((duplicate) => <div key={`${duplicate.offer_number}-${duplicate.remove}`}><strong>{duplicate.offer_number === "DATANORM" ? "Datanorm-Datei" : `Angebot ${duplicate.offer_number || "ohne Nummer"}`}</strong><span><Check size={14} /> Behalten: {duplicate.keep}</span><span className="is-remove"><Trash2 size={14} /> Löschen: {duplicate.remove}</span></div>)}</div>
        <footer><button className="price-button" type="button" disabled={busy} onClick={onClose}>Abbrechen</button><button className="price-button is-danger" type="button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="is-spinning" size={16} /> : <Trash2 size={16} />} Ersetzen und hochladen</button></footer>
      </section>
    </div>
  );
}

function DatanormView({ uploadRevision, uploading, onOperation }: { uploadRevision: string | null; uploading: boolean; onOperation: (started: boolean) => void }) {
  const [, setSearchParams] = useSearchParams();
  const [queryInput, setQueryInput] = useState("");
  const [search, setSearch] = useState("");
  const [cluster, setCluster] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<TableResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const limit = 100;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await priceRequest<TableResult>(queryPath("/price-comparison/datanorm", {
        search,
        cluster,
        offset,
        limit,
      }), { signal });
      setData(result);
    } catch (loadError) {
      if (!isAbortError(loadError)) setError(errorMessage(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cluster, offset, search]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, uploadRevision]);

  async function exportDatanorm() {
    setExporting(true);
    setError(null);
    try {
      const download = await priceDownload("/price-comparison/exports", {
        method: "POST",
        body: JSON.stringify({ kind: "datanorm", search, cluster }),
      });
      triggerDownload(download, "datanorm-preisvergleich.xlsx");
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  function openArticle(articleNumber: string) {
    setSearchParams({ view: "articles", article: articleNumber });
  }

  async function downloadOfferSource(source: string) {
    setError(null);
    try {
      const download = await priceDownload(`/price-comparison/files/offers/${encodeURIComponent(source)}/download`);
      triggerDownload(download, source);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    }
  }

  return (
    <div className="price-workspace">
      <ViewHeading
        icon={<FileSpreadsheet size={19} />}
        title="Nettopreisabgleich"
        description="Aktuelle Nettopreise mit den gespeicherten Angebotspreisen vergleichen."
        actions={(
          <>
            <button className={`price-button${calculatorOpen ? " is-selected" : ""}`} type="button" onClick={() => setCalculatorOpen((value) => !value)}>
              <Calculator size={16} /> Nettopreisrechner
            </button>
            <button className="price-button" type="button" disabled={exporting || !data?.total} onClick={() => void exportDatanorm()}>
              {exporting ? <LoaderCircle className="is-spinning" size={16} /> : <Download size={16} />} Excel
            </button>
          </>
        )}
      />

      <form className="price-filter-bar" onSubmit={(event) => {
        event.preventDefault();
        setOffset(0);
        setSearch(queryInput.trim());
      }}>
        <label className="price-search-field">
          <span className="sr-only">Datanorm durchsuchen</span>
          <Search aria-hidden="true" size={17} />
          <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Artikelnummer oder Bezeichnung" />
        </label>
        <label>
          <span className="sr-only">Artikelcluster</span>
          <select value={cluster} onChange={(event) => { setCluster(event.target.value); setOffset(0); }}>
            <option value="">Alle Cluster</option>
            {(data?.clusters ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <button className="price-button is-primary" type="submit"><Search size={16} /> Suchen</button>
        {(search || cluster) ? (
          <button className="price-button is-quiet" type="button" onClick={() => {
            setQueryInput(""); setSearch(""); setCluster(""); setOffset(0);
          }}><X size={16} /> Filter löschen</button>
        ) : null}
      </form>

      {calculatorOpen ? (
        <NetPriceCalculator
          uploading={uploading}
          onOperation={onOperation}
          initialSearch={search}
          initialCluster={cluster}
          availableClusters={data?.clusters ?? []}
          uploadRevision={uploadRevision}
          currentRevision={data?.revision ?? ""}
          onArticle={openArticle}
          onSource={downloadOfferSource}
        />
      ) : null}

      {error ? <InlineNotice tone="error" action={<RetryButton onClick={() => load()} />}>{error}</InlineNotice> : null}
      <WarningList warnings={data?.warnings} />
      <DataPanel
        loading={loading}
        empty={!data?.rows.length}
        emptyText={search || cluster ? "Keine Artikel für den aktuellen Filter gefunden." : "Noch keine Datanorm-Daten vorhanden."}
      >
        <TableCaption count={data?.total ?? 0} suffix={data?.active_file ? `Aktiv: ${data.active_file}` : undefined} />
        <DataTable variant="datanorm" columns={data?.columns ?? []} rows={data?.rows ?? []} onArticle={openArticle} onSource={downloadOfferSource} unavailableSources={data?.unavailable_sources} />
        <Pagination offset={offset} limit={limit} total={data?.total ?? 0} disabled={loading} onChange={setOffset} />
      </DataPanel>
    </div>
  );
}

function NetPriceCalculator({
  onOperation,
  uploading,
  uploadRevision,
  initialSearch,
  initialCluster,
  availableClusters,
  currentRevision,
  onArticle,
  onSource,
}: {
  initialSearch: string;
  initialCluster: string;
  availableClusters: string[];
  uploading: boolean;
  onOperation: (started: boolean) => void;
  uploadRevision: string | null;
  currentRevision: string;
  onArticle: (articleNumber: string) => void;
  onSource: (source: string) => Promise<void>;
}) {
  const [presets, setPresets] = useState<ReferencePresets | null>(null);
  const [references, setReferences] = useState<ReferenceArticle[]>([{ article_number: "", weight: 1 }]);
  const [presetName, setPresetName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");
  const [search, setSearch] = useState(initialSearch);
  const [cluster, setCluster] = useState(initialCluster);
  const [result, setResult] = useState<SuggestionResult | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetsRequest = useRef(0);
  const suggestionRequest = useRef(0);
  const presetsController = useRef<AbortController | null>(null);
  const suggestionController = useRef<AbortController | null>(null);
  const referencesInitialized = useRef(false);
  const mounted = useRef(true);
  const suggestionLimit = 100;
  const clusterOptions = useMemo(
    () => [...new Set([...availableClusters, ...(result?.clusters ?? [])])].sort((left, right) => left.localeCompare(right, "de")),
    [availableClusters, result?.clusters],
  );

  const loadPresets = useCallback(async () => {
    presetsController.current?.abort();
    const controller = new AbortController();
    presetsController.current = controller;
    const requestId = ++presetsRequest.current;
    try {
      const loaded = await priceRequest<ReferencePresets>("/price-comparison/reference-presets", { signal: controller.signal });
      if (requestId !== presetsRequest.current) return;
      setPresets(loaded);
      if (!referencesInitialized.current) {
        referencesInitialized.current = true;
        setReferences(normalizeReferences(loaded.defaults));
      }
    } catch (loadError) {
      if (requestId === presetsRequest.current && !isAbortError(loadError)) setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadPresets();
    return () => {
      mounted.current = false;
      presetsController.current?.abort();
      suggestionController.current?.abort();
      presetsRequest.current += 1;
      suggestionRequest.current += 1;
    };
  }, [loadPresets, uploadRevision]);

  useEffect(() => {
    setResult(null);
    setLoading(false);
    setSuggestionOffset(0);
  }, [uploadRevision]);

  const validReferences = useMemo(
    () => references
      .map((reference) => ({ article_number: reference.article_number.trim(), weight: Number(reference.weight) }))
      .filter((reference) => reference.article_number && Number.isFinite(reference.weight) && reference.weight > 0),
    [references],
  );

  async function calculate(nextOffset = 0) {
    if (!validReferences.length) {
      setError("Bitte mindestens einen Referenzartikel mit einem Gewicht größer 0 angeben.");
      return;
    }
    suggestionController.current?.abort();
    const controller = new AbortController();
    suggestionController.current = controller;
    const requestId = ++suggestionRequest.current;
    setLoading(true);
    setError(null);
    try {
      const nextResult = await priceRequest<SuggestionResult>("/price-comparison/suggestions/preview", {
        method: "POST",
        body: JSON.stringify({ references: validReferences, search: search.trim(), cluster, offset: nextOffset, limit: suggestionLimit }),
        signal: controller.signal,
      });
      if (requestId !== suggestionRequest.current) return;
      setSuggestionOffset(nextOffset);
      setResult(nextResult);
    } catch (calculateError) {
      if (requestId === suggestionRequest.current && !isAbortError(calculateError)) setError(errorMessage(calculateError));
    } finally {
      if (requestId === suggestionRequest.current) setLoading(false);
    }
  }

  async function savePreset() {
    if (uploading) return;
    const name = presetName.trim();
    if (!name || !validReferences.length) {
      setError("Für eine Vorlage werden ein Name und mindestens ein gültiger Referenzartikel benötigt.");
      return;
    }
    onOperation(true);
    setSaving(true);
    setError(null);
    try {
      await priceRequest(`/price-comparison/reference-presets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ references: validReferences, expected_revision: presets?.revision || currentRevision }),
      });
      if (!mounted.current) return;
      setSelectedPreset(name);
      setPresetName("");
      await loadPresets();
    } catch (saveError) {
      if (mounted.current) setError(mutationErrorMessage(saveError));
    } finally {
      onOperation(false);
      if (mounted.current) setSaving(false);
    }
  }

  async function deletePreset() {
    if (uploading) return;
    if (!selectedPreset || !window.confirm(`Vorlage „${selectedPreset}“ wirklich löschen?`)) return;
    onOperation(true);
    setSaving(true);
    setError(null);
    try {
      await priceRequest(queryPath(`/price-comparison/reference-presets/${encodeURIComponent(selectedPreset)}`, {
        expected_revision: presets?.revision || currentRevision,
      }), { method: "DELETE" });
      if (!mounted.current) return;
      setSelectedPreset("");
      await loadPresets();
    } catch (deleteError) {
      if (mounted.current) setError(mutationErrorMessage(deleteError));
    } finally {
      onOperation(false);
      if (mounted.current) setSaving(false);
    }
  }

  async function exportSuggestions() {
    try {
      const download = await priceDownload("/price-comparison/exports", {
        method: "POST",
        body: JSON.stringify({ kind: "suggestions", search, cluster, references: validReferences }),
      });
      triggerDownload(download, "nettopreis-vorschlaege.xlsx");
    } catch (exportError) {
      setError(errorMessage(exportError));
    }
  }

  return (
    <section className="net-price-calculator" aria-labelledby="net-price-calculator-title">
      <div className="calculator-heading">
        <div>
          <span className="price-kicker">Optionale Kalkulation</span>
          <h3 id="net-price-calculator-title">Vorschlag aktualisierter Nettopreise</h3>
          <p>Gewichtete Referenzen übertragen den Marktaufschlag auf vergleichbare Artikel.</p>
        </div>
        <div className="calculator-rules">
          <span>24 Monate</span><span>nur Erstangebote</span><span>mindestens 5 Preise</span>
        </div>
      </div>

      <div className="calculator-layout">
        <div className="reference-editor">
          <div className="reference-preset-row">
            <label>
              <span>Vorlage</span>
              <select value={selectedPreset} onChange={(event) => {
                const name = event.target.value;
                setSelectedPreset(name);
                setResult(null);
                setSuggestionOffset(0);
                if (name && presets?.presets[name]) setReferences(normalizeReferences(presets.presets[name]));
                if (!name && presets) setReferences(normalizeReferences(presets.defaults));
              }}>
                <option value="">Standardreferenzen</option>
                {Object.keys(presets?.presets ?? {}).sort().map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
            {selectedPreset ? (
              <button className="price-icon-button is-danger" type="button" title="Vorlage löschen" aria-label="Vorlage löschen" disabled={uploading || saving} onClick={() => void deletePreset()}>
                <Trash2 size={16} />
              </button>
            ) : null}
          </div>

          <div className="reference-list-heading"><strong>Referenzartikel</strong><span>{formatInteger(references.length)} Einträge</span></div>
          <div className="reference-list" aria-label="Gewichtete Referenzartikel">
            {references.map((reference, index) => (
              <div className="reference-row" key={index}>
                <label>
                  <span>Artikelnummer {index + 1}</span>
                  <input value={reference.article_number} onChange={(event) => {
                    setResult(null);
                    setSuggestionOffset(0);
                    setReferences((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, article_number: event.target.value } : item));
                  }} />
                </label>
                <label>
                  <span>Gewicht</span>
                  <input type="number" min="0.01" step="0.25" value={reference.weight} onChange={(event) => {
                    setResult(null);
                    setSuggestionOffset(0);
                    setReferences((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, weight: Number(event.target.value) } : item));
                  }} />
                </label>
                <button className="price-icon-button" type="button" title="Referenz entfernen" aria-label={`Referenz ${index + 1} entfernen`} disabled={references.length === 1} onClick={() => {
                  setResult(null);
                  setSuggestionOffset(0);
                  setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index));
                }}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          <button className="price-text-button" type="button" onClick={() => {
            setResult(null);
            setSuggestionOffset(0);
            setReferences((current) => [...current, { article_number: "", weight: 1 }]);
          }}>
            <Plus size={15} /> Referenz hinzufügen
          </button>

          <div className="save-preset-row">
            <label>
              <span className="sr-only">Name der neuen Vorlage</span>
              <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Vorlage benennen" />
            </label>
            <button className="price-button" type="button" disabled={uploading || saving || !presetName.trim()} onClick={() => void savePreset()}>
              <Save size={16} /> Speichern
            </button>
          </div>
        </div>

        <div className="calculator-query">
          <label><span>Ergebnis durchsuchen</span><input value={search} onChange={(event) => { setSearch(event.target.value); setResult(null); setSuggestionOffset(0); }} placeholder="Artikel oder Bezeichnung" /></label>
          <label>
            <span>Artikelcluster</span>
            <select value={cluster} onChange={(event) => { setCluster(event.target.value); setResult(null); setSuggestionOffset(0); }}>
              <option value="">Alle Cluster</option>
              {clusterOptions.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <button className="price-button is-primary" type="button" disabled={loading} onClick={() => void calculate(0)}>
            {loading ? <LoaderCircle className="is-spinning" size={16} /> : <Calculator size={16} />} Vorschläge berechnen
          </button>
        </div>
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {result ? (
        <div className="suggestion-results">
          <div className="price-metrics">
            <Metric label="Gültige Referenzen" value={formatInteger(result.meta.reference_articles_valid.length)} />
            <Metric label="Referenzfaktor" value={formatDecimal(result.meta.reference_ratio, 3)} />
            <Metric label="Abweichung" value={formatPercent(result.meta.reference_deviation_pct)} />
            <Metric label="Geeignete Artikel" value={formatInteger(result.meta.eligible_article_count)} />
          </div>
          <WarningList warnings={result.warnings} />
          <div className="suggestion-result-heading">
            <TableCaption count={result.total} suffix="Vorschläge basieren auf qualifizierten Erstangeboten" />
            <button className="price-button" type="button" disabled={!result.total} onClick={() => void exportSuggestions()}><Download size={16} /> Excel</button>
          </div>
          <DataTable variant="suggestions" columns={result.columns} rows={result.rows} onArticle={onArticle} onSource={onSource} unavailableSources={result.unavailable_sources} />
          <Pagination offset={suggestionOffset} limit={suggestionLimit} total={result.total} disabled={loading} onChange={(nextOffset) => void calculate(nextOffset)} />
        </div>
      ) : (
        <p className="calculator-empty">Referenzen prüfen und „Vorschläge berechnen“ wählen. Es werden noch keine Daten verändert.</p>
      )}
    </section>
  );
}

function OffersView({ uploadRevision, uploading, onUploadBlock, onOperation }: { uploadRevision: string | null; uploading: boolean; onUploadBlock: (reason: string | null) => void; onOperation: (started: boolean) => void }) {
  const [queryInput, setQueryInput] = useState("");
  const [search, setSearch] = useState("");
  const [offerType, setOfferType] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<OffersResult | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const offerDetailRef = useRef<HTMLElement>(null);
  const limit = 20;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setData(await priceRequest<OffersResult>(queryPath("/price-comparison/offers", {
        search,
        offer_type: offerType,
        offset,
        limit,
      }), { signal }));
    } catch (loadError) {
      if (!isAbortError(loadError)) setError(errorMessage(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [offerType, offset, search]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, uploadRevision]);

  useEffect(() => {
    if (!selectedSource || !window.matchMedia("(max-width: 1180px)").matches) return;
    const frame = window.requestAnimationFrame(() => offerDetailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSource]);

  return (
    <div className="price-workspace is-offers">
      <ViewHeading icon={<FileArchive size={19} />} title="Angebote OBO" description="Projektangebote prüfen, korrigieren und in Bestellformate exportieren." />
      <form className="price-filter-bar price-offer-filters" onSubmit={(event) => {
        event.preventDefault(); setOffset(0); setSearch(queryInput.trim());
      }}>
        <label className="price-search-field">
          <span className="sr-only">Angebote durchsuchen</span><Search size={17} />
          <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Projekt, Angebotsnummer oder Datei" />
        </label>
        <div className="price-offer-type-filter">
          <MapFilterSelect
            label="Angebotsart"
            value={offerType}
            options={offerTypeFilterOptions}
            onChange={(value) => { setOfferType(value); setOffset(0); }}
          />
        </div>
        <button className="price-button is-primary" type="submit"><Search size={16} /> Suchen</button>
        {(search || offerType) ? <button className="price-button is-quiet" type="button" onClick={() => { setQueryInput(""); setSearch(""); setOfferType(""); setOffset(0); }}><X size={16} /> Filter löschen</button> : null}
      </form>
      {error ? <InlineNotice tone="error" action={<RetryButton onClick={() => load()} />}>{error}</InlineNotice> : null}
      <WarningList warnings={data?.warnings} />

      <div className={`offers-layout${selectedSource ? " has-detail" : ""}`}>
        <DataPanel loading={loading} empty={!data?.offers.length} emptyText={search || offerType ? "Keine Angebote für den aktuellen Filter gefunden." : "Noch keine Angebote eingelesen."}>
          <TableCaption count={data?.total ?? 0} />
          <div className="offer-list" role="list">
            {(data?.offers ?? []).map((offer) => (
              <button
                key={offer.source}
                type="button"
                role="listitem"
                disabled={loading}
                className={`offer-list-item${selectedSource === offer.source ? " is-selected" : ""}`}
                onClick={() => setSelectedSource(offer.source)}
              >
                <span className="offer-list-primary"><strong>{offer.project || "Ohne Projekt"}</strong><span>{offer.offer_number || offer.source}</span></span>
                <span className="offer-list-meta"><OfferTypeBadge type={offer.offer_type} /><span>{formatDate(offer.date)}</span><span>{formatInteger(offer.position_count)} Pos.</span></span>
                <span className="offer-list-price">
                  <strong>{formatCurrency(offer.total_net)}</strong>
                  <small>Projektwert <b>{formatPercent(offer.price_change)}</b></small>
                  <small>Positionen <b>{formatPercent(offer.price_change_positions)}</b></small>
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
          <Pagination offset={offset} limit={limit} total={data?.total ?? 0} disabled={loading} onChange={setOffset} />
        </DataPanel>

        {selectedSource ? (
          <OfferDetails
            key={selectedSource}
            detailRef={offerDetailRef}
            source={selectedSource}
            onClose={() => setSelectedSource(null)}
            onMutation={load}
            uploadRevision={uploadRevision}
            uploading={uploading}
            onUploadBlock={onUploadBlock}
            onOperation={onOperation}
          />
        ) : null}
      </div>
    </div>
  );
}

function OfferDetails({ detailRef, source, onClose, onMutation, uploadRevision, uploading, onUploadBlock, onOperation }: { detailRef: RefObject<HTMLElement | null>; source: string; onClose: () => void; onMutation: () => Promise<void>; uploadRevision: string | null; uploading: boolean; onUploadBlock: (reason: string | null) => void; onOperation: (started: boolean) => void }) {
  const [data, setData] = useState<OfferPositionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discount, setDiscount] = useState("0");
  const [offerType, setOfferType] = useState<OfferType>("Erstangebot");
  const [alignNetto, setAlignNetto] = useState(false);
  const [initialDiscount, setInitialDiscount] = useState(0);
  const [initialOfferType, setInitialOfferType] = useState<OfferType>("Erstangebot");
  const [initialAlignNetto, setInitialAlignNetto] = useState(false);
  const [manualPrices, setManualPrices] = useState<Record<string, string>>({});
  const [initialManualPrices, setInitialManualPrices] = useState<Record<string, string>>({});
  const [selectedArticles, setSelectedArticles] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const initialDetailScrollDone = useRef(false);
  const [acknowledgedUpload, setAcknowledgedUpload] = useState(uploadRevision);
  const attemptedUpload = useRef(uploadRevision);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const latestUploadRevision = useRef(uploadRevision);
  useEffect(() => { latestUploadRevision.current = uploadRevision; }, [uploadRevision]);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const requestId = ++loadRequest.current;
    const revisionAtStart = latestUploadRevision.current;
    attemptedUpload.current = revisionAtStart;
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<OfferPositionsResult>(`/price-comparison/offers/${encodeURIComponent(source)}/positions`, { signal: controller.signal });
      if (requestId !== loadRequest.current) return;
      setData(loaded);
      setAcknowledgedUpload(revisionAtStart);
      setDiscount(String(loaded.offer.discount ?? 0));
      setOfferType(loaded.offer.offer_type);
      setAlignNetto(Boolean(loaded.offer.align_netto));
      setInitialDiscount(loaded.offer.discount ?? 0);
      setInitialOfferType(loaded.offer.offer_type);
      setInitialAlignNetto(Boolean(loaded.offer.align_netto));
      const manual = manualPriceValues(loaded.rows);
      setManualPrices(manual);
      setInitialManualPrices(manual);
      setSelectedArticles(new Set());
    } catch (loadError) {
      if (requestId === loadRequest.current && !isAbortError(loadError)) {
        if (revisionAtStart && loadError instanceof PriceComparisonError && loadError.status === 404) {
          closeRef.current();
          return;
        }
        setError(errorMessage(loadError));
      }
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    setData(null);
    void load();
    return () => {
      loadController.current?.abort();
      loadRequest.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!data || initialDetailScrollDone.current || !window.matchMedia("(max-width: 1180px)").matches) return;
    initialDetailScrollDone.current = true;
    const frame = window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [data, detailRef]);

  const hasUnsavedChanges = parseGermanNumber(discount) !== initialDiscount || offerType !== initialOfferType || alignNetto !== initialAlignNetto
    || Object.entries(manualPrices).some(([article, value]) => value !== initialManualPrices[article]);
  useEffect(() => {
    onUploadBlock(hasUnsavedChanges ? "Bitte zuerst die offenen Angebotsänderungen speichern." : null);
    return () => onUploadBlock(null);
  }, [hasUnsavedChanges, onUploadBlock]);

  useEffect(() => {
    if (uploadRevision !== acknowledgedUpload && uploadRevision !== attemptedUpload.current && !hasUnsavedChanges && !saving && !loading) void load();
  }, [uploadRevision, acknowledgedUpload, hasUnsavedChanges, saving, loading, load]);

  const offerColumns = useMemo(() => visibleColumns(data?.columns ?? []), [data?.columns]);

  async function patchOffer(payload: Record<string, unknown>) {
    if (!data || uploading) return;
    onOperation(true);
    setSaving(true);
    setError(null);
    try {
      await priceRequest(`/price-comparison/offers/${encodeURIComponent(source)}`, {
        method: "PATCH",
        body: JSON.stringify({ expected_revision: data.revision, ...payload }),
      });
      await Promise.all([load(), onMutation()]);
    } catch (saveError) {
      setError(mutationErrorMessage(saveError));
    } finally {
      onOperation(false);
      setSaving(false);
    }
  }

  async function saveChanges() {
    const manualChanges: Record<string, number | null> = {};
    Object.entries(manualPrices).forEach(([articleNumber, rawValue]) => {
      if (rawValue === initialManualPrices[articleNumber]) return;
      const parsed = parseGermanNumber(rawValue);
      manualChanges[articleNumber] = rawValue.trim() === "" ? null : parsed;
    });
    if (Object.values(manualChanges).some((value) => value !== null && !Number.isFinite(value))) {
      setError("Mindestens ein manueller Preis ist ungültig.");
      return;
    }
    const parsedDiscount = parseGermanNumber(discount);
    if (!Number.isFinite(parsedDiscount)) {
      setError("Bitte einen gültigen Rabatt eingeben.");
      return;
    }
    const changes: Record<string, unknown> = {};
    if (parsedDiscount !== initialDiscount) changes.discount = parsedDiscount;
    if (offerType !== initialOfferType) changes.offer_type = offerType;
    if (alignNetto !== initialAlignNetto) changes.align_netto = alignNetto;
    if (Object.keys(manualChanges).length) changes.manual_prices = manualChanges;
    if (Object.keys(changes).length) await patchOffer(changes);
  }

  async function exportOffer(kind: "offer" | "offer_pdf" | "offer_ugl") {
    setExporting(kind);
    setError(null);
    try {
      const download = await priceDownload("/price-comparison/exports", {
        method: "POST",
        body: JSON.stringify({ kind, source }),
      });
      const extension = kind === "offer" ? "xlsx" : kind === "offer_pdf" ? "pdf" : "ugl";
      triggerDownload(download, `angebot-${data?.offer.offer_number || "export"}.${extension}`);
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setExporting(null);
    }
  }

  async function downloadOriginal() {
    setExporting("original");
    try {
      const download = await priceDownload(`/price-comparison/files/offers/${encodeURIComponent(source)}/download`);
      triggerDownload(download, source);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section ref={detailRef} className="offer-detail" aria-label="Angebotsdetails">
      <header className="offer-detail-header">
        <div>
          <span className="price-kicker">Angebot bearbeiten</span>
          <h3>{data?.offer.project || "Angebot"}</h3>
          <p>{data?.offer.offer_number || source}</p>
          {data ? <div className="offer-detail-comparison"><span>Projektwert <strong>{formatPercent(data.offer.price_change)}</strong></span><span>Positionen <strong>{formatPercent(data.offer.price_change_positions)}</strong></span></div> : null}
        </div>
        <button className="price-icon-button" type="button" aria-label="Angebotsdetails schließen" title="Schließen" disabled={saving || uploading} onClick={onClose}><X size={18} /></button>
      </header>
      {uploadRevision !== acknowledgedUpload ? <InlineNotice tone="info" action={<button className="price-button" type="button" disabled={saving || loading || uploading} onClick={() => {
        if (!hasUnsavedChanges || window.confirm("Die Angebotsdaten neu laden und Ihre ungespeicherten Änderungen verwerfen?")) void load();
      }}><RefreshCw size={16} /> Angebot neu laden</button>}>Neue Angebote wurden hochgeladen. Ihre offene Bearbeitung bleibt erhalten; Vergleichspreise können sich geändert haben.</InlineNotice> : null}
      {error ? <InlineNotice tone="error" action={<RetryButton onClick={() => { void load(); }} />}>{error}</InlineNotice> : null}
      {loading && !data ? <LoadingState label="Angebotspositionen werden geladen" /> : data ? (
        <>
          {loading ? <LoadingState label="Angebotspositionen werden aktualisiert" compact /> : null}
          <WarningList warnings={data.warnings} />
          <div className="offer-settings-grid">
            <label><span>Angebotsart</span><select value={offerType} disabled={saving || loading || uploading} onChange={(event) => setOfferType(event.target.value as OfferType)}>{offerTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
            <label><span>Rabatt in %</span><input inputMode="decimal" value={discount} disabled={saving || loading || uploading} onChange={(event) => setDiscount(event.target.value)} /></label>
            <label className="price-check"><input type="checkbox" checked={alignNetto} disabled={saving || loading || uploading} onChange={(event) => setAlignNetto(event.target.checked)} /><span><strong>Nettoabgleich</strong><small>Höhere Preise auf Datanorm-Netto begrenzen</small></span></label>
            <button className="price-button is-primary" type="button" disabled={saving || loading || uploading} onClick={() => void saveChanges()}>{saving ? <LoaderCircle className="is-spinning" size={16} /> : <Save size={16} />} Änderungen speichern</button>
          </div>

          <div className="offer-position-table-wrap">
            <table className="price-table offer-position-table">
              <thead><tr><th className="price-select-cell"><span className="sr-only">Auswahl</span></th>{offerColumns.map((column) => <th key={column}>{columnLabel(column, "offer")}</th>)}<th>Manueller Preis</th></tr></thead>
              <tbody>{data.rows.map((row, index) => {
                const articleNumber = String(row.Artikelnummer ?? row.article_number ?? "");
                return (
                  <tr key={`${articleNumber}-${index}`}>
                    <td className="price-select-cell"><input type="checkbox" aria-label={`${articleNumber || `Position ${index + 1}`} zum Löschen auswählen`} checked={selectedArticles.has(articleNumber)} disabled={saving || loading || uploading || !articleNumber} onChange={(event) => setSelectedArticles((current) => {
                      const next = new Set(current); if (event.target.checked) next.add(articleNumber); else next.delete(articleNumber); return next;
                    })} /></td>
                    {offerColumns.map((column) => <td key={column} className={cellClass(column, row[column])}>{formatCell(column, row[column])}</td>)}
                    <td className="manual-price-cell"><input aria-label={`Manueller Preis ${articleNumber}`} inputMode="decimal" placeholder="unverändert" value={manualPrices[articleNumber] ?? ""} disabled={saving || loading || uploading || !articleNumber} onChange={(event) => setManualPrices((current) => ({ ...current, [articleNumber]: event.target.value }))} /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>

          {data.offer.original_available === false ? (
            <InlineNotice tone="info">Die Positionen dieses Angebots sind erhalten. Die Original-PDF war im Online-Preisviewer nicht mehr vorhanden. Excel, PDF-Export und UGL bleiben verfügbar.</InlineNotice>
          ) : null}
          <div className="offer-detail-actions">
            <div>
              <button className="price-button" type="button" disabled={saving || Boolean(exporting) || data.offer.original_available === false} title={data.offer.original_available === false ? "Die Original-PDF ist nicht vorhanden." : undefined} onClick={() => void downloadOriginal()}><FileText size={16} /> Original-PDF</button>
              <button className="price-button" type="button" disabled={saving || Boolean(exporting)} onClick={() => void exportOffer("offer")}><Download size={16} /> Excel</button>
              <button className="price-button" type="button" disabled={saving || Boolean(exporting)} onClick={() => void exportOffer("offer_pdf")}><Download size={16} /> PDF</button>
              <button className="price-button" type="button" disabled={saving || Boolean(exporting)} onClick={() => void exportOffer("offer_ugl")}><Download size={16} /> UGL</button>
            </div>
            <div>
              <button className="price-button" type="button" disabled={uploading || saving || loading || data.rows.length === 0} onClick={() => void patchOffer({ reset_manual_prices: true })}><RotateCcw size={16} /> Manuelle Preise zurücksetzen</button>
              <button className="price-button is-danger" type="button" disabled={uploading || saving || loading || selectedArticles.size === 0} onClick={() => {
                if (window.confirm(`${selectedArticles.size} ausgewählte Artikel aus diesem Angebot entfernen?`)) void patchOffer({ delete_articles: [...selectedArticles] });
              }}><Trash2 size={16} /> Auswahl entfernen</button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ArticlesView({ articleSearch, uploadRevision }: { articleSearch: ArticleSearchIndex; uploadRevision: string | null }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [selectedArticle, setSelectedArticle] = useState<string | null>(searchParams.get("article"));
  const routeArticle = searchParams.get("article");
  const articles = useMemo(() => articleSearch.snapshot
    ? searchArticleIndex(articleSearch.snapshot, query)
    : [], [articleSearch.snapshot, query]);

  useEffect(() => {
    setSelectedArticle(routeArticle);
  }, [routeArticle]);

  return (
    <div className="price-workspace">
      <div className="article-layout">
        <section className="article-picker" aria-label="Artikelsuche">
          <label className="price-search-field"><Search size={17} /><span className="sr-only">Artikel suchen</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Artikelnummer oder Text" /></label>
          {articleSearch.loading && !articleSearch.snapshot ? <LoadingState label="Artikelindex wird geladen" compact /> : null}
          {articleSearch.error && !articleSearch.snapshot ? <InlineNotice tone="error" action={<RetryButton onClick={articleSearch.retry} />}>{articleSearch.error}</InlineNotice> : null}
          {articleSearch.stale && articleSearch.snapshot ? (
            <InlineNotice tone="info" action={articleSearch.error ? <RetryButton onClick={articleSearch.retry} /> : undefined}>
              {articleSearch.error
                ? "Der Artikelindex konnte nicht aktualisiert werden. Die Treffer stammen aus dem zuletzt geladenen Datenstand."
                : "Der Artikelindex wird aktualisiert. Die Treffer können bis zum Abschluss noch dem vorherigen Datenstand entsprechen."}
            </InlineNotice>
          ) : null}
          <div className="article-result-list" role="listbox" aria-label="Gefundene Artikel" aria-busy={articleSearch.loading && !articleSearch.snapshot}>
            {articles.map((article) => {
              const summary = summarizeArticleDescription(article.description);
              const price = article.net_price === null ? "—" : formatCurrency(article.net_price);
              const compactSummary = [summary.description, summary.quality].filter(Boolean).join(" · ");
              return (
                <button
                  key={article.article_number}
                  type="button"
                  role="option"
                  aria-label={`${article.article_number} | ${summary.shortName}. ${compactSummary}. Preis ${price}`}
                  aria-selected={selectedArticle === article.article_number}
                  className={selectedArticle === article.article_number ? "is-selected" : undefined}
                  title={`${article.article_number} | ${summary.shortName}\n${compactSummary}`}
                  onClick={() => {
                    setSelectedArticle(article.article_number);
                    const next = new URLSearchParams(searchParams);
                    next.set("view", "articles");
                    next.set("article", article.article_number);
                    setSearchParams(next);
                  }}
                >
                  <span className="article-result-copy">
                    <strong className="article-result-heading">
                      <span>{article.article_number}</span><span aria-hidden="true"> | </span><span className="article-result-short-name">{summary.shortName}</span>
                    </strong>
                    <small className="article-result-description">{summary.description}</small>
                    {summary.quality ? <small className="article-result-quality">{summary.quality}</small> : null}
                  </span>
                  <span className="article-result-price">{price}</span>
                </button>
              );
            })}
            {articleSearch.snapshot && !articles.length ? <p className="compact-empty">Keine Artikel gefunden.</p> : null}
          </div>
        </section>
        {selectedArticle ? <ArticleDetail articleNumber={selectedArticle} uploadRevision={uploadRevision} /> : (
          <div className="article-detail-placeholder"><ChartNoAxesCombined size={30} /><strong>Artikel auswählen</strong><span>Preisverlauf, Kennzahlen und Angebotsquellen erscheinen hier.</span></div>
        )}
      </div>
    </div>
  );
}

const ArticleDetail = memo(function ArticleDetail({ articleNumber, uploadRevision }: { articleNumber: string; uploadRevision: string | null }) {
  const [data, setData] = useState<ArticleDetailResult | null>(null);
  const [dataArticleNumber, setDataArticleNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"bars" | "line">("bars");
  const [enabledTypes, setEnabledTypes] = useState<Set<OfferType>>(new Set(offerTypes));
  const [exporting, setExporting] = useState(false);
  const [retainedDetailHeight, setRetainedDetailHeight] = useState<number | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const requestId = ++loadRequest.current;
    setDataArticleNumber(articleNumber);
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<ArticleDetailResult>(`/price-comparison/articles/${encodeURIComponent(articleNumber)}`, { signal: controller.signal });
      if (requestId === loadRequest.current) setData(loaded);
    } catch (loadError) {
      if (requestId === loadRequest.current && !isAbortError(loadError)) setError(errorMessage(loadError));
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [articleNumber]);

  useEffect(() => {
    setData(null);
    void load();
    return () => {
      loadController.current?.abort();
      loadRequest.current += 1;
    };
  }, [load, uploadRevision]);

  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (!detail || loading || !data || dataArticleNumber !== articleNumber) return;
    const retainHeight = () => setRetainedDetailHeight(Math.ceil(detail.getBoundingClientRect().height));
    retainHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(retainHeight);
    observer.observe(detail);
    return () => observer.disconnect();
  }, [articleNumber, data, dataArticleNumber, loading]);

  const { filteredRows, filteredStats, netPrice, medianDelta } = useMemo(() => {
    const nextFilteredRows = (data?.rows ?? []).filter((row) => enabledTypes.has(String(row.Angebotsart ?? "Erstangebot") as OfferType));
    const prices = nextFilteredRows.map((row) => toNumber(row.Preis)).filter((value): value is number => value !== null);
    const recentPrices = nextFilteredRows
      .filter((row) => isWithinLastMonths(row.Datum, 24))
      .map((row) => toNumber(row.Preis))
      .filter((value): value is number => value !== null);
    const nextFilteredStats = prices.length
      ? { minimum: Math.min(...prices), maximum: Math.max(...prices), median24: recentPrices.length ? median(recentPrices) : null }
      : { minimum: null, maximum: null, median24: null };
    const nextNetPrice = toNumber(data?.article.Nettopreis);
    const nextMedianDelta = nextFilteredStats.median24 !== null && nextNetPrice !== null && nextNetPrice !== 0
      ? ((nextFilteredStats.median24 - nextNetPrice) / nextNetPrice) * 100
      : (nextFilteredStats.median24 !== null ? data?.statistics.median_delta_pct ?? null : null);
    return {
      filteredRows: nextFilteredRows,
      filteredStats: nextFilteredStats,
      netPrice: nextNetPrice,
      medianDelta: nextMedianDelta,
    };
  }, [data, enabledTypes]);

  async function exportArticle(kind: "article" | "article_pdf") {
    setExporting(true);
    setError(null);
    try {
      const download = await priceDownload("/price-comparison/exports", {
        method: "POST",
        body: JSON.stringify({ kind, article_number: articleNumber, offer_types: [...enabledTypes] }),
      });
      triggerDownload(download, `${articleNumber}-preisvergleich.${kind === "article" ? "csv" : "pdf"}`);
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  async function downloadSource(source: string) {
    try {
      const download = await priceDownload(`/price-comparison/files/offers/${encodeURIComponent(source)}/download`);
      triggerDownload(download, source);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    }
  }

  const detailStyle = retainedDetailHeight === null ? undefined : { minHeight: `${retainedDetailHeight}px` };
  if (loading || dataArticleNumber !== articleNumber) return <section className="article-detail is-loading" style={detailStyle}><LoadingState label="Preisverlauf wird geladen" /></section>;
  if (error && !data) return <section className="article-detail" style={detailStyle}><InlineNotice tone="error" action={<RetryButton onClick={load} />}>{error}</InlineNotice></section>;
  if (!data) return null;
  const historyColumns = articleHistoryColumns(data.columns);
  const shortName = String(data.article.Kurzbezeichnung ?? "").trim()
    || summarizeArticleDescription(data.article.Bezeichnung ?? data.article.description).shortName;
  const weight = articleWeightLabel(data.article.Bezeichnung ?? data.article.description);

  return (
    <section ref={detailRef} className="article-detail">
      <header className="article-detail-header">
        <h3>{articleNumber}<span aria-hidden="true"> | </span><span className="article-short-name">{shortName}</span><span aria-hidden="true"> | </span><span className="article-weight">{weight ?? "Gewicht: —"}</span></h3>
      </header>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <WarningList warnings={data.warnings} />
      <div className="article-controls">
        <div className="price-segmented" aria-label="Diagrammtyp">
          <button type="button" className={chartMode === "bars" ? "is-active" : undefined} onClick={() => setChartMode("bars")}>Balken</button>
          <button type="button" className={chartMode === "line" ? "is-active" : undefined} onClick={() => setChartMode("line")}>Linie</button>
        </div>
        <div className="article-controls-actions">
          <fieldset className="offer-type-filter"><legend className="sr-only">Angebotsarten</legend>{offerTypes.map((type) => <label key={type}><input type="checkbox" checked={enabledTypes.has(type)} onChange={(event) => setEnabledTypes((current) => {
            const next = new Set(current); if (event.target.checked) next.add(type); else next.delete(type); return next;
          })} /><span>{shortOfferType(type)}</span></label>)}</fieldset>
          <ArticleExportMenu key={articleNumber} exporting={exporting} onExport={(kind) => void exportArticle(kind)} />
        </div>
      </div>
      <div className="price-metrics article-metrics">
        <Metric label="Minimum" value={formatCurrency(filteredStats.minimum)} />
        <Metric label="Maximum" value={formatCurrency(filteredStats.maximum)} />
        <div className="price-metric article-median">
          <span>Median 24 Monate</span>
          <div className="article-median-value">
            <strong>{formatCurrency(filteredStats.median24)}</strong>
            {medianDelta === null ? null : <small>Zur Datanorm <span className={medianDelta > 0 ? "is-positive" : medianDelta < 0 ? "is-negative" : undefined}>{formatPercent(medianDelta)}</span></small>}
          </div>
        </div>
        <Metric label="Angebotspreise" value={formatInteger(filteredRows.length)} />
      </div>
      <PriceHistoryChart key={articleNumber} rows={filteredRows} netPrice={netPrice} medianDelta={medianDelta} mode={chartMode} />
      <div className="article-history-table-wrap">
        {filteredRows.length ? (
          <table className="price-table article-history-table">
            <colgroup>{historyColumns.map((column) => <col key={column} style={{ width: articleHistoryColumnWidths[column] }} />)}<col style={{ width: "44px" }} /></colgroup>
            <thead><tr>{historyColumns.map((column) => <th key={column}>{columnLabel(column, "article")}</th>)}<th><span className="sr-only">Angebot herunterladen</span></th></tr></thead>
            <tbody>{filteredRows.map((row, index) => (
              <tr key={`${String(row.Quelle)}-${index}`}>
                {historyColumns.map((column) => {
                  const value = row[column];
                  const text = value === null || value === undefined ? undefined : String(value);
                  return (
                    <td key={column} className={cellClass(column, value)} title={text}>
                      <span className="article-history-cell">{formatCell(column, value)}</span>
                    </td>
                  );
                })}
                <td className="article-download-cell">
                  <button
                    className="source-download-button"
                    type="button"
                    disabled={!row.Quelle || data.unavailable_sources?.includes(String(row.Quelle))}
                    aria-label={!row.Quelle || data.unavailable_sources?.includes(String(row.Quelle)) ? "Original-PDF nicht vorhanden" : `${String(row.Quelle)} herunterladen`}
                    title={!row.Quelle || data.unavailable_sources?.includes(String(row.Quelle)) ? "Die Original-PDF ist nicht vorhanden." : `${String(row.Quelle)} herunterladen`}
                    onClick={() => void downloadSource(String(row.Quelle))}
                  ><Download size={15} aria-hidden="true" /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="compact-empty">Für die ausgewählten Angebotsarten sind keine Preise vorhanden.</p>}
      </div>
    </section>
  );
});

function ArticleExportMenu({ exporting, onExport }: { exporting: boolean; onExport: (kind: "article" | "article_pdf") => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialItem = useRef(0);
  const menuId = useId();

  useLayoutEffect(() => {
    if (open) itemRefs.current[initialItem.current]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="article-export-menu" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }}>
      <button ref={triggerRef} type="button" className="price-icon-button article-export-trigger"
        aria-label="Artikelvergleich herunterladen" title="Artikelvergleich herunterladen"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={exporting}
        onClick={() => { initialItem.current = 0; setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            initialItem.current = event.key === "ArrowUp" ? 1 : 0;
            setOpen(true);
          }
        }}>
        {exporting ? <LoaderCircle size={18} className="is-spinning" aria-hidden="true" /> : <Ellipsis size={20} aria-hidden="true" />}
      </button>
      {open ? <div id={menuId} role="menu" aria-label="Dokumententyp" className="article-export-options" onKeyDown={(event) => {
        const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (current + 1) % 2
          : event.key === "ArrowUp" ? (current + 1) % 2
            : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
        if (next !== null) { event.preventDefault(); itemRefs.current[next]?.focus(); }
      }}>
        {(["article", "article_pdf"] as const).map((kind, index) => (
          <button key={kind} ref={(element) => { itemRefs.current[index] = element; }} type="button" role="menuitem"
            onClick={() => { setOpen(false); triggerRef.current?.focus(); onExport(kind); }}>
            <Download size={15} aria-hidden="true" /> {kind === "article" ? "CSV herunterladen" : "PDF herunterladen"}
          </button>
        ))}
      </div> : null}
    </div>
  );
}

type PriceChartPoint = { price: number; date: string; type: OfferType; offerName: string };
type PriceChartTooltipState = { index: number; anchor: DOMRect; points: PriceChartPoint[]; mode: "bars" | "line" };

function PriceHistoryChart({ rows, netPrice, medianDelta, mode }: { rows: Array<Record<string, unknown>>; netPrice: number | null; medianDelta: number | null; mode: "bars" | "line" }) {
  const points = useMemo(() => rows
    .map((row) => ({
      price: toNumber(row.Preis),
      date: String(row.Datum ?? ""),
      type: String(row.Angebotsart ?? "Erstangebot") as OfferType,
      offerName: [row.Projekt, row.Angebot, row.Quelle]
        .map((value) => String(value ?? "").trim())
        .find((value) => value && value !== "—") ?? "Ohne Angebotsname",
    }))
    .filter((point): point is PriceChartPoint => point.price !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), [rows]);
  const chartRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const datesRef = useRef<SVGSVGElement>(null);
  const scrollPoints = useRef(points);
  const [viewportWidth, setViewportWidth] = useState(720);
  const viewportId = useId();
  const tooltipId = useId();
  const [tooltip, setTooltip] = useState<PriceChartTooltipState | null>(null);
  const activeTooltip = tooltip?.points === points && tooltip.mode === mode ? tooltip : null;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => { if (viewport.clientWidth > 0) setViewportWidth(viewport.clientWidth); };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  const layout = getPriceChartLayout(points.length, viewportWidth, mode);
  const maxScroll = layout.maxScroll;
  // Scroll updates only the range and date strip, never the entire SVG tree.
  const syncScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const visible = getPriceChartWindow(getPriceChartLayout(points.length, viewportWidth, mode), points.length, viewport.scrollLeft);
    if (datesRef.current) datesRef.current.style.transform = `translateX(${-visible.scrollLeft}px)`;
    if (rangeRef.current) {
      rangeRef.current.value = String(visible.scrollLeft);
      rangeRef.current.setAttribute("aria-valuetext", `Angebote ${visible.first} bis ${visible.last} von ${points.length}`);
    }
  }, [points.length, viewportWidth, mode]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // A changed layout invalidates the tooltip's saved screen coordinates.
    setTooltip(null);
    viewport.scrollLeft = scrollPoints.current === points ? Math.min(viewport.scrollLeft, maxScroll) : 0;
    scrollPoints.current = points;
    syncScroll();
  }, [points, maxScroll, syncScroll]);

  useEffect(() => {
    if (!activeTooltip) return;
    const close = () => setTooltip(null);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !chartRef.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [activeTooltip]);

  function showTooltip(index: number, target: SVGElement) {
    setTooltip({ index, anchor: target.getBoundingClientRect(), points, mode });
  }

  const median24Prices = points.filter((point) => isWithinLastMonths(point.date, 24)).map((point) => point.price);
  const median24 = median24Prices.length ? median(median24Prices) : null;

  const width = layout.contentWidth;
  const height = 260;
  const padding = { top: 24, bottom: 1 };
  const references = [
    ...(netPrice === null ? [] : [netPrice]),
    ...(median24 === null ? [] : [median24]),
  ];
  const { floor, ceiling } = getPriceChartDomain(points.map((point) => point.price), references);
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => (index + 0.5) * layout.slotWidth;
  const y = (value: number) => padding.top + (1 - (value / 2 - floor / 2) / (ceiling / 2 - floor / 2)) * plotHeight;
  const linePath = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.price)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, index) => floor * (1 - index / 4) + ceiling * (index / 4)).reverse();
  const barWidth = layout.barWidth;
  const netLabelY = netPrice === null ? 12 : Math.max(12, y(netPrice) - 7);
  let medianLabelY = median24 === null ? 12 : Math.max(12, y(median24) - 7);
  if (netPrice !== null && Math.abs(netLabelY - medianLabelY) < 14) {
    medianLabelY = netLabelY + 22 < height - 4 ? netLabelY + 22 : netLabelY - 14;
  }

  function moveViewport(left: number) {
    if (viewportRef.current) viewportRef.current.scrollLeft = Math.max(0, Math.min(left, maxScroll));
    syncScroll();
    setTooltip(null);
  }

  return (
    <div className="price-chart-shell">
      <div className="price-chart-layout">
      <svg className="price-chart-y-axis" viewBox={`0 0 66 ${height}`} aria-hidden="true">
        {points.length ? ticks.map((tick) => <text key={tick} x="56" y={Math.min(height - 3, y(tick) + 4)} textAnchor="end" className="chart-axis-label">{formatChartPrice(tick, ceiling / 4 - floor / 4)}</text>) : null}
      </svg>
      <div ref={viewportRef} id={viewportId} className="price-chart-scroll" tabIndex={maxScroll > 0 ? 0 : undefined} role="group" aria-label={maxScroll > 0 ? "Preisdiagramm, horizontal scrollbar" : "Preisdiagramm"} onScroll={syncScroll}>
      <svg ref={chartRef} className="price-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Preisverlauf mit ${points.length} Angebotspreisen`}>
        {points.length ? <>
        {ticks.map((tick) => <line key={tick} x1="0" x2={width} y1={y(tick)} y2={y(tick)} className="chart-grid-line" />)}
        {netPrice !== null ? <line x1="0" x2={width} y1={y(netPrice)} y2={y(netPrice)} className="chart-net-line" /> : null}
        {mode === "line" && median24 !== null ? <line x1="0" x2={width} y1={y(median24)} y2={y(median24)} className="chart-median-line" /> : null}
        {mode === "line" ? <path d={linePath} className="chart-history-line" /> : null}
        {points.map((point, index) => {
          const interaction = {
            tabIndex: 0,
            role: "button",
            "aria-label": `${formatCurrency(point.price)} · ${point.offerName} · ${formatDate(point.date)}`,
            onPointerEnter: (event: React.PointerEvent<SVGElement>) => showTooltip(index, event.currentTarget),
            onPointerLeave: (event: React.PointerEvent<SVGElement>) => {
              if (event.pointerType !== "touch" && document.activeElement !== event.currentTarget) setTooltip(null);
            },
            onFocus: (event: React.FocusEvent<SVGElement>) => showTooltip(index, event.currentTarget),
            onBlur: (event: React.FocusEvent<SVGElement>) => { if (!event.currentTarget.matches(":hover")) setTooltip(null); },
            onClick: (event: React.MouseEvent<SVGElement>) => showTooltip(index, event.currentTarget),
            onKeyDown: (event: React.KeyboardEvent<SVGElement>) => {
              if (event.key === "Escape") setTooltip(null);
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                showTooltip(index, event.currentTarget);
              }
            },
          };
          return mode === "bars"
            ? <rect key={`${point.date}-${index}`} {...interaction} x={x(index) - barWidth / 2} y={y(point.price)} width={barWidth} height={padding.top + plotHeight - y(point.price)} rx="2" className={`chart-bar is-${offerTypeClass(point.type)}`} />
            : <circle key={`${point.date}-${index}`} {...interaction} cx={x(index)} cy={y(point.price)} r="5" className={`chart-point is-${offerTypeClass(point.type)}`} />;
        })}
        </> : <text x={width / 2} y={height / 2} textAnchor="middle" className="chart-empty-label"><tspan x={width / 2}>Keine Angebotspreise</tspan><tspan x={width / 2} dy="18">für das Diagramm.</tspan></text>}
      </svg>
      </div>
      <svg className="price-chart-reference-labels" width={layout.viewportWidth} height={height} viewBox={`0 0 ${layout.viewportWidth} ${height}`} aria-hidden="true">
        {points.length && netPrice !== null ? <text x={layout.viewportWidth - 7} y={netLabelY} textAnchor="end" className="chart-net-label">Datanorm {formatCurrency(netPrice)}</text> : null}
        {points.length && mode === "line" && median24 !== null ? <text x="7" y={medianLabelY} className="chart-median-label">Median 24 Monate {formatCurrency(median24)}{medianDelta === null ? "" : ` (${formatPercent(medianDelta)})`}</text> : null}
      </svg>
      <div className="price-chart-navigation">
        {maxScroll > 0 ? <input ref={rangeRef} type="range" min="0" max={maxScroll} step="1" defaultValue="0" aria-label="Preisverlauf horizontal verschieben" aria-controls={viewportId} onChange={(event) => moveViewport(Number(event.target.value))} onKeyDown={(event) => {
          const current = viewportRef.current?.scrollLeft ?? 0;
          const targets: Record<string, number> = {
            ArrowLeft: current - layout.slotWidth,
            ArrowRight: current + layout.slotWidth,
            PageUp: current - layout.viewportWidth,
            PageDown: current + layout.viewportWidth,
            Home: 0,
            End: maxScroll,
          };
          if (event.key in targets) {
            event.preventDefault();
            moveViewport(targets[event.key]);
          }
        }} /> : null}
      </div>
      <div className="price-chart-dates" aria-hidden="true">
        <svg ref={datesRef} width={width} height="28" viewBox={`0 0 ${width} 28`}>
          {getPriceChartDateLabels(layout, points.length).map(({ index, x: labelX }) => <text key={`label-${points[index].date}-${index}`} x={labelX} y="17" textAnchor="middle" className="chart-axis-label">{shortDate(points[index].date)}</text>)}
        </svg>
      </div>
      </div>
      <div className="chart-legend"><span className="is-first">Erstangebot</span><span className="is-follow">Folgeangebot</span><span className="is-negotiated">Verhandelt</span><span className="is-net">Datanorm-Netto</span>{mode === "line" && median24 !== null ? <span className="is-median">Median 24 Monate</span> : null}</div>
      {activeTooltip ? <PriceChartTooltip id={tooltipId} point={points[activeTooltip.index]} anchor={activeTooltip.anchor} /> : null}
    </div>
  );
}

function PriceChartTooltip({ id, point, anchor }: { id: string; point: PriceChartPoint; anchor: DOMRect }) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const preferredLeft = anchor.right + 10;
    const left = preferredLeft + bounds.width <= window.innerWidth - 12
      ? preferredLeft : anchor.left - bounds.width - 10;
    element.style.left = `${Math.max(12, Math.min(left, window.innerWidth - bounds.width - 12))}px`;
    element.style.top = `${Math.max(12, Math.min(anchor.top, window.innerHeight - bounds.height - 12))}px`;
  }, [anchor]);

  return createPortal(
    <div ref={tooltipRef} id={id} role="tooltip" className="price-chart-tooltip">
      <strong>{formatCurrency(point.price)}</strong>
      <span>{point.offerName}</span>
      <time dateTime={point.date}>{formatDate(point.date)}</time>
    </div>,
    document.body,
  );
}

function FilesView({ status, onMutation, uploadRevision, uploading, onOperation }: { status: PriceComparisonStatus | null; onMutation: (files: FilesResult) => void; uploadRevision: string | null; uploading: boolean; onOperation: (started: boolean) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [data, setData] = useState<FilesResult | null>(null);
  const [search, setSearch] = useState("");
  const [datanormFiles, setDatanormFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuildPreview, setRebuildPreview] = useState<RebuildPreview | null>(null);
  const [uploadDuplicatePreview, setUploadDuplicatePreview] = useState<UploadDuplicatePreview | null>(null);
  const datanormInputId = useId();
  const rebuildDialogRef = useRef<HTMLElement | null>(null);
  const loadRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<FilesResult>("/price-comparison/files", { signal: controller.signal });
      if (requestId !== loadRequest.current) return null;
      setData(loaded);
      return loaded;
    } catch (loadError) {
      if (requestId === loadRequest.current && !isAbortError(loadError)) setError(errorMessage(loadError));
      return null;
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadController.current?.abort();
      loadRequest.current += 1;
    };
  }, [load, uploadRevision]);

  useEffect(() => {
    if (!rebuildPreview) return;
    rebuildDialogRef.current?.focus();
  }, [rebuildPreview]);

  async function upload(kind: PriceFile["kind"], files: File[], confirmation?: Pick<UploadDuplicatePreview, "duplicates" | "revision">) {
    if (!files.length) return;
    onOperation(true);
    setBusy(`upload-${kind}`);
    setError(null);
    try {
      await uploadPriceFiles(kind, files, confirmation?.revision ?? data?.revision ?? status?.revision ?? "", confirmation?.duplicates.map((duplicate) => duplicate.remove));
      setDatanormFiles([]);
      setUploadDuplicatePreview(null);
      const refreshed = await load();
      if (refreshed) onMutation(refreshed);
    } catch (uploadError) {
      const duplicateDetail = duplicateUploadDetail(uploadError);
      if (duplicateDetail) {
        setUploadDuplicatePreview({ kind, files, ...duplicateDetail });
        return;
      }
      if (confirmation) setUploadDuplicatePreview(null);
      setError(mutationErrorMessage(uploadError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  async function deleteFile(file: PriceFile) {
    const confirmation = file.original_available === false
      ? `Die übernommenen Positionen von „${file.name}“ wirklich löschen? Für dieses Angebot ist keine Original-PDF vorhanden, aus der sie wieder eingelesen werden könnten.`
      : file.active
      ? `„${file.name}“ ist die aktive Datanorm. Nach dem Löschen stehen bis zur Auswahl bzw. zum Upload einer neuen Datanorm keine Vergleichspreise bereit. Wirklich löschen?`
      : `„${file.name}“ wirklich löschen?`;
    if (!window.confirm(confirmation)) return;
    onOperation(true);
    setBusy(`delete-${file.kind}-${file.name}`);
    setError(null);
    try {
      await priceRequest(queryPath(`/price-comparison/files/${file.kind}/${encodeURIComponent(file.name)}`, {
        expected_revision: data?.revision ?? status?.revision,
      }), { method: "DELETE" });
      const refreshed = await load();
      if (refreshed) onMutation(refreshed);
    } catch (deleteError) {
      setError(mutationErrorMessage(deleteError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  async function downloadFile(file: PriceFile) {
    onOperation(true);
    setBusy(`download-${file.kind}-${file.name}`);
    setError(null);
    try {
      const download = await priceDownload(`/price-comparison/files/${file.kind}/${encodeURIComponent(file.name)}/download`);
      triggerDownload(download, file.name);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  async function runMaintenance(action: "rebuild_offers" | "reparse_datanorm" | "refresh_percentages") {
    if (action === "rebuild_offers") {
      await previewRebuild();
      return;
    }
    onOperation(true);
    setBusy(`maintenance-${action}`);
    setError(null);
    try {
      await priceRequest("/price-comparison/maintenance", {
        method: "POST",
        body: JSON.stringify({ action, expected_revision: data?.revision ?? status?.revision }),
      });
      const refreshed = await load();
      if (refreshed) onMutation(refreshed);
    } catch (maintenanceError) {
      setError(mutationErrorMessage(maintenanceError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  async function previewRebuild() {
    onOperation(true);
    setBusy("maintenance-rebuild_offers");
    setError(null);
    try {
      const preview = await priceRequest<RebuildPreview>("/price-comparison/maintenance/preview", {
        method: "POST",
        body: JSON.stringify({ action: "rebuild_offers", expected_revision: data?.revision ?? status?.revision }),
      });
      if (preview.duplicates.length) {
        setRebuildPreview(preview);
      } else {
        await confirmRebuild(preview);
      }
    } catch (previewError) {
      setError(mutationErrorMessage(previewError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  async function confirmRebuild(preview: RebuildPreview) {
    onOperation(true);
    setBusy("maintenance-rebuild_offers");
    setError(null);
    try {
      await priceRequest("/price-comparison/maintenance", {
        method: "POST",
        body: JSON.stringify({
          action: "rebuild_offers",
          expected_revision: preview.revision,
          confirmed_duplicates: preview.duplicates.map((duplicate) => duplicate.remove),
        }),
      });
      setRebuildPreview(null);
      const refreshed = await load();
      if (refreshed) onMutation(refreshed);
    } catch (rebuildError) {
      setRebuildPreview(null);
      setError(mutationErrorMessage(rebuildError));
    } finally {
      onOperation(false);
      setBusy(null);
    }
  }

  const effectiveBusy = busy || (uploading ? "header-upload" : null);
  const normalizedSearch = search.trim().toLocaleLowerCase("de");
  const visibleFiles = [...(data?.files ?? [])]
    .filter((file) => !normalizedSearch || file.name.toLocaleLowerCase("de").includes(normalizedSearch))
    .sort((left, right) => {
      const byModified = new Date(right.modified).getTime() - new Date(left.modified).getTime();
      return Number.isFinite(byModified) && byModified !== 0 ? byModified : left.name.localeCompare(right.name, "de");
    });
  const offers = visibleFiles.filter((file) => file.kind === "offers");
  const datanorm = visibleFiles.filter((file) => file.kind === "datanorm");

  return (
    <div className="price-workspace">
      <ViewHeading icon={<FolderSync size={19} />} title="Dateien" description="Angebots-PDFs und Datanorm-Dateien verwalten und den Datenbestand warten." actions={<button className="price-button" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /> Aktualisieren</button>} />
      <label className="price-search-field files-search"><Search size={17} /><span className="sr-only">Dateien suchen</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Dateiname filtern" /></label>
      {error ? <InlineNotice tone="error" action={<RetryButton onClick={() => { void load(); }} />}>{error}</InlineNotice> : null}

      <div className="file-sections">
        <FileSection title="Angebote (PDF)" description="Neue Angebote können Sie oben über „Angebote hochladen“ hinzufügen." files={offers} loading={loading} busy={effectiveBusy} onDownload={downloadFile} onDelete={deleteFile} />
        <FileSection title="Datanorm" description="Die aktive Datanorm bildet die Basis für Netto- und Artikelpreise." files={datanorm} loading={loading} busy={effectiveBusy} upload={{ inputId: datanormInputId, selectedFiles: datanormFiles, accept: ".dat,.txt,text/plain", multiple: true, onFiles: setDatanormFiles, onUpload: () => void upload("datanorm", datanormFiles) }} onDownload={downloadFile} onDelete={deleteFile} />
      </div>

      {isAdmin ? (
        <section className="maintenance-panel">
          <div><span className="price-kicker">Nur Administration</span><h3>Datenbestand warten</h3><p>Parser- und Vergleichscaches gezielt aus den gespeicherten Quelldateien erneuern.</p></div>
          <div className="maintenance-actions">
            <button className="price-button" type="button" disabled={loading || Boolean(effectiveBusy)} onClick={() => void runMaintenance("rebuild_offers")}><RefreshCw size={16} /> Angebote neu aufbauen</button>
            <button className="price-button" type="button" disabled={loading || Boolean(effectiveBusy)} onClick={() => void runMaintenance("reparse_datanorm")}><RefreshCw size={16} /> Datanorm neu einlesen</button>
            <button className="price-button" type="button" disabled={loading || Boolean(effectiveBusy)} onClick={() => void runMaintenance("refresh_percentages")}><RefreshCw size={16} /> Prozentwerte aktualisieren</button>
          </div>
        </section>
      ) : null}
      {rebuildPreview ? (
        <div className="price-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setRebuildPreview(null);
        }}>
          <section ref={rebuildDialogRef} className="price-modal" role="dialog" aria-modal="true" aria-labelledby="rebuild-preview-title" tabIndex={-1} onKeyDown={(event) => {
            if (event.key === "Escape") setRebuildPreview(null);
          }}>
            <header><div><span className="price-kicker">Bestätigung erforderlich</span><h3 id="rebuild-preview-title">Doppelte Angebote bereinigen</h3></div><button className="price-icon-button" type="button" aria-label="Dialog schließen" onClick={() => setRebuildPreview(null)}><X size={18} /></button></header>
            <p>Beim Neuaufbau werden die folgenden älteren Dateien mit derselben Angebotsnummer gelöscht. Die jeweils neuere Datei bleibt erhalten.</p>
            <WarningList warnings={rebuildPreview.warnings} />
            <div className="duplicate-preview-list">{rebuildPreview.duplicates.map((duplicate) => <div key={`${duplicate.offer_number}-${duplicate.remove}`}><strong>Angebot {duplicate.offer_number || "ohne Nummer"}</strong><span><Check size={14} /> Behalten: {duplicate.keep}</span><span className="is-remove"><Trash2 size={14} /> Löschen: {duplicate.remove}</span></div>)}</div>
            <InlineNotice tone="info">Der Neuaufbau stellt Positionen aus den PDF-Quelldateien wieder her. Zuvor manuell entfernte Artikel können dadurch erneut erscheinen.</InlineNotice>
            <footer><button className="price-button" type="button" onClick={() => setRebuildPreview(null)}>Abbrechen</button><button className="price-button is-danger" type="button" disabled={Boolean(busy)} onClick={() => void confirmRebuild(rebuildPreview)}><Trash2 size={16} /> Löschen und neu aufbauen</button></footer>
          </section>
        </div>
      ) : null}
      {uploadDuplicatePreview ? <UploadDuplicateDialog preview={uploadDuplicatePreview} busy={Boolean(busy)} onClose={() => setUploadDuplicatePreview(null)} onConfirm={() => void upload(uploadDuplicatePreview.kind, uploadDuplicatePreview.files, uploadDuplicatePreview)} /> : null}
    </div>
  );
}

function FileSection({ title, description, files, loading, busy, upload, onDownload, onDelete }: {
  title: string;
  description: string;
  files: PriceFile[];
  loading: boolean;
  busy: string | null;
  upload?: {
    inputId: string;
    selectedFiles: File[];
    accept: string;
    multiple: boolean;
    onFiles: (files: File[]) => void;
    onUpload: () => void;
  };
  onDownload: (file: PriceFile) => void;
  onDelete: (file: PriceFile) => void;
}) {
  return (
    <section className="file-section">
      <header><div><h3>{title}</h3><p>{description}</p></div><span>{formatInteger(files.length)} {files.some((file) => file.original_available === false) ? "Einträge" : "Dateien"}</span></header>
      {upload ? <div className="file-upload-row">
        <input key={upload.selectedFiles.map((file) => `${file.name}-${file.size}-${file.lastModified}`).join("|") || "empty"} id={upload.inputId} className="sr-only" type="file" accept={upload.accept} multiple={upload.multiple} onChange={(event) => upload.onFiles(Array.from(event.target.files ?? []))} />
        <label className="price-button" htmlFor={upload.inputId}><Plus size={16} /> Dateien auswählen</label>
        <span title={upload.selectedFiles.map((file) => file.name).join(", ")}>{upload.selectedFiles.length ? `${upload.selectedFiles.length} ausgewählt` : "Keine Auswahl"}</span>
        <button className="price-button is-primary" type="button" disabled={loading || !upload.selectedFiles.length || Boolean(busy)} onClick={upload.onUpload}>{busy?.startsWith("upload-") ? <LoaderCircle className="is-spinning" size={16} /> : <Upload size={16} />} Hochladen</button>
      </div> : null}
      {loading ? <LoadingState label={`${title} werden geladen`} compact /> : null}
      {files.length ? (
        <div className="file-list">{files.map((file) => {
          return <div className="file-list-item" key={`${file.kind}-${file.name}`}>
            <FileText size={18} aria-hidden="true" />
            <div><strong>{file.name}</strong><span>{file.original_available === false ? "Positionen erhalten · Original-PDF fehlt" : `${formatFileSize(file.size)} · ${formatDateTime(file.modified)}`}</span>{file.included_in_comparison === false ? <span>Im übernommenen Online-Vergleich nicht enthalten</span> : null}</div>
            {file.active ? <span className="active-file-badge"><Check size={13} /> Aktiv</span> : null}
            <div className="file-actions"><button className="price-icon-button" type="button" title={file.original_available === false ? "Die Original-PDF ist nicht vorhanden." : "Herunterladen"} aria-label={`${file.name} herunterladen`} disabled={loading || Boolean(busy) || file.original_available === false} onClick={() => onDownload(file)}><Download size={16} /></button><button className="price-icon-button is-danger" type="button" title="Löschen" aria-label={`${file.name} löschen`} disabled={loading || Boolean(busy)} onClick={() => onDelete(file)}><Trash2 size={16} /></button></div>
          </div>;
        })}</div>
      ) : loading ? null : <p className="compact-empty">Keine Dateien vorhanden.</p>}
    </section>
  );
}

function ViewHeading({ icon, title, description, actions }: { icon: ReactNode; title: string; description: string; actions?: ReactNode }) {
  return <div className="price-view-heading"><div className="price-view-heading-copy"><span className="price-view-icon">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></div>{actions ? <div className="price-view-actions">{actions}</div> : null}</div>;
}

function InlineNotice({ tone, children, action }: { tone: "error" | "info" | "success"; children: ReactNode; action?: ReactNode }) {
  return <div className={`price-notice is-${tone}`} role={tone === "error" ? "alert" : "status"}><span>{children}</span>{action}</div>;
}

function WarningList({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return <div className="price-warning-list" role="status"><strong>Hinweise aus den Quelldateien</strong><ul>{warnings.slice(0, 5).map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>{warnings.length > 5 ? <span>und {warnings.length - 5} weitere Hinweise</span> : null}</div>;
}

function RetryButton({ onClick }: { onClick: () => void | Promise<void> }) {
  return <button className="price-text-button" type="button" onClick={() => void onClick()}><RefreshCw size={14} /> Erneut laden</button>;
}

function DataPanel({ loading, empty, emptyText, children }: { loading: boolean; empty: boolean; emptyText: string; children: ReactNode }) {
  if (loading && empty) return <div className="price-data-panel"><LoadingState label="Daten werden geladen" /></div>;
  if (empty) return <div className="price-data-panel"><div className="price-empty-state"><FileSpreadsheet size={26} /><strong>Keine Daten</strong><span>{emptyText}</span></div></div>;
  return <div className="price-data-panel" aria-busy={loading}>{loading ? <LoadingState label="Daten werden aktualisiert" compact /> : null}{children}</div>;
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`price-loading${compact ? " is-compact" : ""}`} role="status"><LoaderCircle className="is-spinning" size={18} /><span>{label}</span></div>;
}

function TableCaption({ count, suffix }: { count: number; suffix?: string }) {
  return <div className="price-table-caption"><strong>{formatInteger(count)} Treffer</strong>{suffix ? <span>{suffix}</span> : null}</div>;
}

function DataTable({ columns, rows, onArticle, onSource, unavailableSources = [], variant = "generic" }: {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  onArticle?: (articleNumber: string) => void;
  onSource?: (source: string) => void | Promise<void>;
  unavailableSources?: string[];
  variant?: PriceTableVariant;
}) {
  const renderedColumns = useMemo(() => tableColumns(columns, variant), [columns, variant]);
  const unavailableSourceSet = useMemo(() => new Set(unavailableSources), [unavailableSources]);
  return <div className={`price-table-wrap is-${variant}`}><table className="price-table"><thead><tr>{renderedColumns.map((column) => <th key={column}>{columnLabel(column, variant)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{renderedColumns.map((column) => {
    const value = row[column];
    const offerPriceMatch = column.match(/^Angebotspreis\s+(\d+)$/i);
    const source = offerPriceMatch ? String(row[`AP${offerPriceMatch[1]}_src`] ?? (offerPriceMatch[1] === "1" ? row.AP_best_src ?? "" : "")) : "";
    const content = column === "Artikelnummer" && value && onArticle
      ? <button className="table-link-button" type="button" onClick={() => onArticle(String(value))}>{String(value)}</button>
      : offerPriceMatch && value !== null && value !== undefined && source && onSource
        ? unavailableSourceSet.has(source)
          ? <span title={`${source}: Die Original-PDF ist nicht vorhanden.`}>{formatCell(column, value)}</span>
          : <button className="table-link-button is-price" type="button" title={`${source} herunterladen`} onClick={() => void onSource(source)}>{formatCell(column, value)}<Download size={12} /></button>
        : formatCell(column, value);
    const classes = [cellClass(column, value), comparisonCellClass(column, value, row)].filter(Boolean).join(" ") || undefined;
    return <td key={column} className={classes}>{content}</td>;
  })}</tr>)}</tbody></table></div>;
}

function Pagination({ offset, limit, total, disabled = false, onChange }: { offset: number; limit: number; total: number; disabled?: boolean; onChange: (offset: number) => void }) {
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + limit, total);
  return <div className="price-pagination" aria-label="Seitennavigation"><span>{formatInteger(start)}–{formatInteger(end)} von {formatInteger(total)}</span><div><button className="price-icon-button" type="button" aria-label="Vorherige Seite" disabled={disabled || offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft size={17} /></button><button className="price-icon-button" type="button" aria-label="Nächste Seite" disabled={disabled || offset + limit >= total} onClick={() => onChange(offset + limit)}><ChevronRight size={17} /></button></div></div>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="price-metric"><span>{label}</span><strong>{value}</strong>{hint ? <small>{hint}</small> : null}</div>;
}

function OfferTypeBadge({ type }: { type: OfferType }) {
  return <span className={`offer-type-badge is-${offerTypeClass(type)}`}>{shortOfferType(type)}</span>;
}

function visibleColumns(columns: string[]): string[] {
  return columns.filter((column) => !column.startsWith("_") && !/^AP\d_(src|disc)$/.test(column) && column !== "AP_best_src");
}

function tableColumns(columns: string[], variant: PriceTableVariant): string[] {
  const preferred = variant === "datanorm"
    ? ["Artikelnummer", "Bezeichnung", "Einheit", "Preis-Typ", "Nettopreis", "Angebotspreis 1", "Angebotspreis 2", "Angebotspreis 3", "Angebotspreis 4", "Angebotspreis 5"]
    : variant === "suggestions"
      ? ["Preisvergleich", "Artikelnummer", "Bezeichnung", "Artikelcluster", "Cluster-Sicherheit", "Aktueller Nettopreis", "Medianangebotspreis", "Vorschlag Nettopreis"]
      : [];
  if (preferred.length) return preferred.filter((column) => columns.includes(column));
  return visibleColumns(columns);
}

function columnLabel(column: string, variant: PriceTableVariant): string {
  const shared: Record<string, string> = {
    "Preis-Typ": "Preistyp",
    Nettopreis: "Datanorm-Netto",
    "Aktueller Nettopreis": "Netto aktuell",
    "Vorschlag Nettopreis": "Netto Vorschlag",
    Medianangebotspreis: "Angebotsmedian",
    "Gesamt (netto)": "Gesamt netto",
    "Cluster-Sicherheit": "Zuordnung",
  };
  if (shared[column]) return shared[column];
  const offerPrice = column.match(/^Angebotspreis\s+(\d+)$/);
  if (offerPrice) return `Angebot ${offerPrice[1]}`;
  if (column === "Preisvergleich") return "Bewertung";
  if (variant === "offer" && column === "Preis") return "Angebotspreis";
  if (variant === "offer" && column === "Preis_min") return "Vergleich min.";
  if (variant === "offer" && column === "Preis_max") return "Vergleich max.";
  if (variant === "article" && column === "Preis") return "Angebotspreis";
  if (variant === "article" && column === "Quelle") return "Original-PDF";
  return column;
}

function articleHistoryColumns(columns: string[]): string[] {
  const preferred = ["Datum", "Preis", "Menge", "Projekt", "Angebot", "Angebotsart", "Gesamt (netto)"];
  const selected = preferred.filter((column) => columns.includes(column));
  return selected.length ? selected : visibleColumns(columns).filter((column) => column !== "Quelle").slice(0, 10);
}

function cellClass(column: string, value: unknown): string | undefined {
  const classes = [];
  if (column === "Bezeichnung") classes.push("is-description");
  if (typeof value === "number" && /preis|netto|summe|gesamt|rabatt|median|abweichung|%|menge/i.test(column)) classes.push("is-numeric");
  return classes.join(" ") || undefined;
}

function comparisonCellClass(column: string, value: unknown, row: Record<string, unknown>): string | undefined {
  const match = column.match(/^Angebotspreis\s+(\d+)$/i);
  if (!match) return undefined;
  const price = toNumber(value);
  const netPrice = toNumber(row.Nettopreis);
  const discounted = row[`AP${match[1]}_disc`] === true;
  const classes = [];
  if (price !== null && netPrice !== null) {
    if (price < netPrice) classes.push("is-offer-below-net");
    else if (price > netPrice) classes.push("is-offer-above-net");
  }
  if (discounted) classes.push("is-discounted-offer");
  return classes.join(" ") || undefined;
}

function formatCell(column: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="price-null">—</span>;
  if (column === "Cluster-Sicherheit") return String(value).trim().toLocaleLowerCase("de-DE") === "sicher" ? "Sicher" : "Unsicher";
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (column === "Einheit" && typeof value === "string") return ({ STCK: "st", MTR: "m" } as Record<string, string>)[value] ?? value;
  if (column === "Bezeichnung" && typeof value === "string") {
    const compact = value.replace(/\s*\n\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
    return <span className="price-description-text" title={compact}>{compact}</span>;
  }
  if (typeof value === "number") {
    if (/%|prozent|abweichung/i.test(column)) return formatPercent(value);
    if (/preis|netto|summe|gesamt|median/i.test(column)) return formatCurrency(value);
    return decimalFormatter.format(value);
  }
  if (typeof value === "string" && /datum|date/i.test(column)) return formatDate(value);
  return String(value);
}

function manualPriceValues(rows: Array<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  rows.forEach((row) => {
    const articleNumber = String(row.Artikelnummer ?? row.article_number ?? "");
    if (!articleNumber) return;
    const explicit = row["Manueller Preis"] ?? row.manual_price;
    const value = explicit ?? row.Preis;
    result[articleNumber] = value === null || value === undefined ? "" : String(value).replace(".", ",");
  });
  return result;
}

function normalizeReferences(references: ReferenceArticle[]): ReferenceArticle[] {
  return references.length ? references.map((reference) => ({ ...reference })) : [{ article_number: "", weight: 1 }];
}

function shortOfferType(type: OfferType): string {
  return type === "Verhandeltes Angebot" ? "Verhandelt" : type;
}

function offerTypeClass(type: OfferType): string {
  if (type === "Folgeangebot") return "follow";
  if (type === "Verhandeltes Angebot") return "negotiated";
  return "first";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Die Daten konnten nicht geladen werden.";
}

function mutationErrorMessage(error: unknown): string {
  if (error instanceof PriceComparisonError && error.status === 409) {
    return "Der Datenstand wurde zwischenzeitlich geändert. Bitte laden Sie die Ansicht neu und führen Sie die Änderung anschließend erneut aus.";
  }
  return errorMessage(error);
}

function duplicateUploadDetail(error: unknown): Pick<UploadDuplicatePreview, "duplicates" | "revision" | "message"> | null {
  if (!(error instanceof PriceComparisonError) || error.status !== 409 || !error.detail || typeof error.detail !== "object") return null;
  const detail = error.detail as { code?: unknown; message?: unknown; duplicates?: unknown; revision?: unknown };
  if (detail.code !== "duplicate_offers" || !Array.isArray(detail.duplicates) || typeof detail.revision !== "string") return null;
  const duplicates = detail.duplicates.filter((item): item is DuplicateOffer => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<DuplicateOffer>;
    return typeof candidate.offer_number === "string" && typeof candidate.keep === "string" && typeof candidate.remove === "string";
  });
  return duplicates.length ? {
    duplicates,
    revision: detail.revision,
    message: typeof detail.message === "string" ? detail.message : undefined,
  } : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = parseGermanNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGermanNumber(value: string): number {
  const clean = value.trim().replace(/\s/g, "");
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  return Number(normalized);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isWithinLastMonths(value: unknown, months: number): boolean {
  if (typeof value !== "string" && !(value instanceof Date)) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setMonth(cutoff.getMonth() - months);
  return date >= cutoff;
}

function formatCurrency(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : currencyFormatter.format(value);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${percentFormatter.format(value)} %`;
}

function formatDecimal(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function shortDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : shortDateFormatter.format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 ** 2).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
}

function formatChartPrice(value: number, step: number): string {
  const digits = step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
  return `${chartPriceFormatters[digits].format(value)} €`;
}
