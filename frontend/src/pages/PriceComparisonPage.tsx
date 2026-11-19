import {
  Calculator,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
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
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import {
  PriceComparisonError,
  type ArticleDetailResult,
  type ArticleSummary,
  type ArticlesResult,
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
  { key: "datanorm", label: "Datanorm ↔ Angebot" },
  { key: "offers", label: "Angebote (alle)" },
  { key: "articles", label: "Artikelvergleich" },
  { key: "files", label: "Dateien" },
];

const offerTypes: OfferType[] = ["Erstangebot", "Folgeangebot", "Verhandeltes Angebot"];

export function PriceComparisonPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view") as ViewKey | null;
  const activeView = views.some((view) => view.key === requestedView) ? requestedView! : "datanorm";
  const [status, setStatus] = useState<PriceComparisonStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isStatusLoading, setIsStatusLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setIsStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await priceRequest<PriceComparisonStatus>("/price-comparison/status"));
    } catch (error) {
      setStatusError(errorMessage(error));
    } finally {
      setIsStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  function selectView(view: ViewKey) {
    const next = new URLSearchParams(searchParams);
    if (view === "datanorm") next.delete("view");
    else next.set("view", view);
    setSearchParams(next);
  }

  return (
    <section className="price-comparison-page page-stack">
      <header className="price-comparison-header">
        <div>
          <p className="eyebrow">Einkauf & Kalkulation</p>
          <h1>Preisvergleich</h1>
          <p className="price-comparison-intro">
            Datanorm-Preise, Projektangebote und Preisverläufe in einer gemeinsamen Arbeitsansicht.
          </p>
        </div>
        <div className="price-status-summary" aria-live="polite">
          {isStatusLoading ? (
            <><LoaderCircle className="is-spinning" size={16} /> Datenstand wird geladen</>
          ) : status ? (
            <>
              <span className={`price-status-dot${status.configured ? " is-ready" : ""}`} aria-hidden="true" />
              <span>
                <strong>{formatInteger(status.offer_count)}</strong> Angebote · {formatInteger(status.datanorm_count)} Datanorm-Dateien
              </span>
              <span className="price-status-source">{status.mode === "onedrive" ? "OneDrive" : "Lokaler Speicher"}</span>
            </>
          ) : (
            <><span className="price-status-dot" aria-hidden="true" /> Status nicht verfügbar</>
          )}
        </div>
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
        {activeView === "datanorm" ? <DatanormView onMutation={loadStatus} /> : null}
        {activeView === "offers" ? <OffersView onMutation={loadStatus} /> : null}
        {activeView === "articles" ? <ArticlesView /> : null}
        {activeView === "files" ? <FilesView status={status} onMutation={loadStatus} /> : null}
      </div>
    </section>
  );
}

function DatanormView({ onMutation }: { onMutation: () => Promise<void> }) {
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
  }, [load]);

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
        title="Datanorm ↔ Angebot"
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
          initialSearch={search}
          initialCluster={cluster}
          availableClusters={data?.clusters ?? []}
          currentRevision={data?.revision ?? ""}
          onMutation={async () => { await load(); await onMutation(); }}
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
        <Pagination offset={offset} limit={limit} total={data?.total ?? 0} onChange={setOffset} />
      </DataPanel>
    </div>
  );
}

function NetPriceCalculator({
  initialSearch,
  initialCluster,
  availableClusters,
  currentRevision,
  onMutation,
  onArticle,
  onSource,
}: {
  initialSearch: string;
  initialCluster: string;
  availableClusters: string[];
  currentRevision: string;
  onMutation: () => Promise<void>;
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
  const referencesInitialized = useRef(false);
  const suggestionLimit = 100;
  const clusterOptions = useMemo(
    () => [...new Set([...availableClusters, ...(result?.clusters ?? [])])].sort((left, right) => left.localeCompare(right, "de")),
    [availableClusters, result?.clusters],
  );

  const loadPresets = useCallback(async () => {
    const requestId = ++presetsRequest.current;
    try {
      const loaded = await priceRequest<ReferencePresets>("/price-comparison/reference-presets");
      if (requestId !== presetsRequest.current) return;
      setPresets(loaded);
      if (!referencesInitialized.current) {
        referencesInitialized.current = true;
        setReferences(normalizeReferences(loaded.defaults));
      }
    } catch (loadError) {
      if (requestId === presetsRequest.current) setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void loadPresets();
    return () => {
      presetsRequest.current += 1;
      suggestionRequest.current += 1;
    };
  }, [loadPresets]);

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
    const requestId = ++suggestionRequest.current;
    setLoading(true);
    setError(null);
    try {
      const nextResult = await priceRequest<SuggestionResult>("/price-comparison/suggestions/preview", {
        method: "POST",
        body: JSON.stringify({ references: validReferences, search: search.trim(), cluster, offset: nextOffset, limit: suggestionLimit }),
      });
      if (requestId !== suggestionRequest.current) return;
      setSuggestionOffset(nextOffset);
      setResult(nextResult);
    } catch (calculateError) {
      if (requestId === suggestionRequest.current) setError(errorMessage(calculateError));
    } finally {
      if (requestId === suggestionRequest.current) setLoading(false);
    }
  }

  async function savePreset() {
    const name = presetName.trim();
    if (!name || !validReferences.length) {
      setError("Für eine Vorlage werden ein Name und mindestens ein gültiger Referenzartikel benötigt.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await priceRequest(`/price-comparison/reference-presets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ references: validReferences, expected_revision: presets?.revision || currentRevision }),
      });
      setSelectedPreset(name);
      setPresetName("");
      await loadPresets();
      await onMutation();
    } catch (saveError) {
      setError(mutationErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function deletePreset() {
    if (!selectedPreset || !window.confirm(`Vorlage „${selectedPreset}“ wirklich löschen?`)) return;
    setSaving(true);
    setError(null);
    try {
      await priceRequest(queryPath(`/price-comparison/reference-presets/${encodeURIComponent(selectedPreset)}`, {
        expected_revision: presets?.revision || currentRevision,
      }), { method: "DELETE" });
      setSelectedPreset("");
      await loadPresets();
      await onMutation();
    } catch (deleteError) {
      setError(mutationErrorMessage(deleteError));
    } finally {
      setSaving(false);
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
              <button className="price-icon-button is-danger" type="button" title="Vorlage löschen" aria-label="Vorlage löschen" disabled={saving} onClick={() => void deletePreset()}>
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
            <button className="price-button" type="button" disabled={saving || !presetName.trim()} onClick={() => void savePreset()}>
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
          <Pagination offset={suggestionOffset} limit={suggestionLimit} total={result.total} onChange={(nextOffset) => void calculate(nextOffset)} />
        </div>
      ) : (
        <p className="calculator-empty">Referenzen prüfen und „Vorschläge berechnen“ wählen. Es werden noch keine Daten verändert.</p>
      )}
    </section>
  );
}

function OffersView({ onMutation }: { onMutation: () => Promise<void> }) {
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
  }, [load]);

  useEffect(() => {
    if (!selectedSource || !window.matchMedia("(max-width: 1180px)").matches) return;
    const frame = window.requestAnimationFrame(() => offerDetailRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSource]);

  return (
    <div className="price-workspace">
      <ViewHeading icon={<FileArchive size={19} />} title="Angebote (alle)" description="Projektangebote prüfen, korrigieren und in Bestellformate exportieren." />
      <form className="price-filter-bar" onSubmit={(event) => {
        event.preventDefault(); setOffset(0); setSearch(queryInput.trim());
      }}>
        <label className="price-search-field">
          <span className="sr-only">Angebote durchsuchen</span><Search size={17} />
          <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Projekt, Angebotsnummer oder Datei" />
        </label>
        <label><span className="sr-only">Angebotsart</span><select value={offerType} onChange={(event) => { setOfferType(event.target.value); setOffset(0); }}>
          <option value="">Alle Angebotsarten</option>{offerTypes.map((type) => <option key={type}>{type}</option>)}
        </select></label>
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
          <Pagination offset={offset} limit={limit} total={data?.total ?? 0} onChange={setOffset} />
        </DataPanel>

        {selectedSource ? (
          <OfferDetails
            key={selectedSource}
            detailRef={offerDetailRef}
            source={selectedSource}
            onClose={() => setSelectedSource(null)}
            onMutation={async () => { await load(); await onMutation(); }}
          />
        ) : null}
      </div>
    </div>
  );
}

function OfferDetails({ detailRef, source, onClose, onMutation }: { detailRef: RefObject<HTMLElement | null>; source: string; onClose: () => void; onMutation: () => Promise<void> }) {
  const [data, setData] = useState<OfferPositionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discount, setDiscount] = useState("0");
  const [offerType, setOfferType] = useState<OfferType>("Erstangebot");
  const [alignNetto, setAlignNetto] = useState(false);
  const [manualPrices, setManualPrices] = useState<Record<string, string>>({});
  const [initialManualPrices, setInitialManualPrices] = useState<Record<string, string>>({});
  const [selectedArticles, setSelectedArticles] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const initialDetailScrollDone = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<OfferPositionsResult>(`/price-comparison/offers/${encodeURIComponent(source)}/positions`);
      if (requestId !== loadRequest.current) return;
      setData(loaded);
      setDiscount(String(loaded.offer.discount ?? 0));
      setOfferType(loaded.offer.offer_type);
      setAlignNetto(Boolean(loaded.offer.align_netto));
      const manual = manualPriceValues(loaded.rows);
      setManualPrices(manual);
      setInitialManualPrices(manual);
      setSelectedArticles(new Set());
    } catch (loadError) {
      if (requestId === loadRequest.current) setError(errorMessage(loadError));
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    setData(null);
    void load();
    return () => { loadRequest.current += 1; };
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

  async function patchOffer(payload: Record<string, unknown>) {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      await priceRequest(`/price-comparison/offers/${encodeURIComponent(source)}`, {
        method: "PATCH",
        body: JSON.stringify({ expected_revision: data.revision, ...payload }),
      });
      await load();
      await onMutation();
    } catch (saveError) {
      setError(mutationErrorMessage(saveError));
    } finally {
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
    await patchOffer({
      discount: parsedDiscount,
      offer_type: offerType,
      align_netto: alignNetto,
      ...(Object.keys(manualChanges).length ? { manual_prices: manualChanges } : {}),
    });
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
        <button className="price-icon-button" type="button" aria-label="Angebotsdetails schließen" title="Schließen" onClick={onClose}><X size={18} /></button>
      </header>
      {error ? <InlineNotice tone="error" action={<RetryButton onClick={load} />}>{error}</InlineNotice> : null}
      {loading ? <LoadingState label="Angebotspositionen werden geladen" /> : data ? (
        <>
          <WarningList warnings={data.warnings} />
          <div className="offer-settings-grid">
            <label><span>Angebotsart</span><select value={offerType} disabled={saving} onChange={(event) => setOfferType(event.target.value as OfferType)}>{offerTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
            <label><span>Rabatt in %</span><input inputMode="decimal" value={discount} disabled={saving} onChange={(event) => setDiscount(event.target.value)} /></label>
            <label className="price-check"><input type="checkbox" checked={alignNetto} disabled={saving} onChange={(event) => setAlignNetto(event.target.checked)} /><span><strong>Nettoabgleich</strong><small>Höhere Preise auf Datanorm-Netto begrenzen</small></span></label>
            <button className="price-button is-primary" type="button" disabled={saving} onClick={() => void saveChanges()}>{saving ? <LoaderCircle className="is-spinning" size={16} /> : <Save size={16} />} Änderungen speichern</button>
          </div>

          <div className="offer-position-table-wrap">
            <table className="price-table offer-position-table">
              <thead><tr><th className="price-select-cell"><span className="sr-only">Auswahl</span></th>{visibleColumns(data.columns).map((column) => <th key={column}>{columnLabel(column, "offer")}</th>)}<th>Manueller Preis</th></tr></thead>
              <tbody>{data.rows.map((row, index) => {
                const articleNumber = String(row.Artikelnummer ?? row.article_number ?? "");
                return (
                  <tr key={`${articleNumber}-${index}`}>
                    <td className="price-select-cell"><input type="checkbox" aria-label={`${articleNumber || `Position ${index + 1}`} zum Löschen auswählen`} checked={selectedArticles.has(articleNumber)} disabled={saving || !articleNumber} onChange={(event) => setSelectedArticles((current) => {
                      const next = new Set(current); if (event.target.checked) next.add(articleNumber); else next.delete(articleNumber); return next;
                    })} /></td>
                    {visibleColumns(data.columns).map((column) => <td key={column} className={cellClass(column, row[column])}>{formatCell(column, row[column])}</td>)}
                    <td className="manual-price-cell"><input aria-label={`Manueller Preis ${articleNumber}`} inputMode="decimal" placeholder="unverändert" value={manualPrices[articleNumber] ?? ""} disabled={saving || !articleNumber} onChange={(event) => setManualPrices((current) => ({ ...current, [articleNumber]: event.target.value }))} /></td>
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
              <button className="price-button" type="button" disabled={saving || data.rows.length === 0} onClick={() => void patchOffer({ reset_manual_prices: true })}><RotateCcw size={16} /> Manuelle Preise zurücksetzen</button>
              <button className="price-button is-danger" type="button" disabled={saving || selectedArticles.size === 0} onClick={() => {
                if (window.confirm(`${selectedArticles.size} ausgewählte Artikel aus diesem Angebot entfernen?`)) void patchOffer({ delete_articles: [...selectedArticles] });
              }}><Trash2 size={16} /> Auswahl entfernen</button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ArticlesView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<string | null>(searchParams.get("article"));
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<number | null>(null);
  const searchRequest = useRef(0);
  const routeArticle = searchParams.get("article");

  const searchArticles = useCallback(async (value: string) => {
    const requestId = ++searchRequest.current;
    setSearching(true);
    setError(null);
    try {
      const result = await priceRequest<ArticlesResult>(queryPath("/price-comparison/articles", { search: value.trim(), limit: 50 }));
      if (requestId === searchRequest.current) setArticles(result.articles);
    } catch (searchError) {
      if (requestId === searchRequest.current) setError(errorMessage(searchError));
    } finally {
      if (requestId === searchRequest.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    void searchArticles("");
    return () => {
      searchRequest.current += 1;
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    };
  }, [searchArticles]);

  useEffect(() => {
    setSelectedArticle(routeArticle);
  }, [routeArticle]);

  function updateQuery(value: string) {
    setQuery(value);
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => void searchArticles(value), 250);
  }

  return (
    <div className="price-workspace">
      <ViewHeading icon={<ChartNoAxesCombined size={19} />} title="Artikelvergleich" description="Preisverlauf eines Datanorm-Artikels über alle gespeicherten Angebote auswerten." />
      <div className="article-layout">
        <section className="article-picker" aria-label="Artikelsuche">
          <label className="price-search-field"><Search size={17} /><span className="sr-only">Artikel suchen</span><input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Artikelnummer oder Text" /></label>
          {searching ? <LoadingState label="Artikel werden gesucht" compact /> : null}
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
          <div className="article-result-list" role="listbox" aria-label="Gefundene Artikel">
            {articles.map((article) => (
              <button key={article.article_number} type="button" role="option" aria-selected={selectedArticle === article.article_number} className={selectedArticle === article.article_number ? "is-selected" : undefined} onClick={() => {
                setSelectedArticle(article.article_number);
                const next = new URLSearchParams(searchParams);
                next.set("view", "articles");
                next.set("article", article.article_number);
                setSearchParams(next);
              }}>
                <span><strong>{article.article_number}</strong><small>{article.description || "Ohne Bezeichnung"}</small></span>
                <span>{article.net_price === null ? "—" : formatCurrency(article.net_price)}</span>
              </button>
            ))}
            {!searching && !articles.length ? <p className="compact-empty">Keine Artikel gefunden.</p> : null}
          </div>
        </section>
        {selectedArticle ? <ArticleDetail articleNumber={selectedArticle} /> : (
          <div className="article-detail-placeholder"><ChartNoAxesCombined size={30} /><strong>Artikel auswählen</strong><span>Preisverlauf, Kennzahlen und Angebotsquellen erscheinen hier.</span></div>
        )}
      </div>
    </div>
  );
}

function ArticleDetail({ articleNumber }: { articleNumber: string }) {
  const [data, setData] = useState<ArticleDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"bars" | "line">("bars");
  const [enabledTypes, setEnabledTypes] = useState<Set<OfferType>>(new Set(offerTypes));
  const [exporting, setExporting] = useState(false);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<ArticleDetailResult>(`/price-comparison/articles/${encodeURIComponent(articleNumber)}`);
      if (requestId === loadRequest.current) setData(loaded);
    } catch (loadError) {
      if (requestId === loadRequest.current) setError(errorMessage(loadError));
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [articleNumber]);

  useEffect(() => {
    setData(null);
    void load();
    return () => { loadRequest.current += 1; };
  }, [load]);

  const filteredRows = useMemo(() => (data?.rows ?? []).filter((row) => enabledTypes.has(String(row.Angebotsart ?? "Erstangebot") as OfferType)), [data?.rows, enabledTypes]);
  const prices = filteredRows.map((row) => toNumber(row.Preis)).filter((value): value is number => value !== null);
  const recentPrices = filteredRows
    .filter((row) => isWithinLastMonths(row.Datum, 24))
    .map((row) => toNumber(row.Preis))
    .filter((value): value is number => value !== null);
  const filteredStats = prices.length
    ? { minimum: Math.min(...prices), maximum: Math.max(...prices), median24: recentPrices.length ? median(recentPrices) : null }
    : { minimum: null, maximum: null, median24: null };
  const netPrice = toNumber(data?.article.Nettopreis);
  const medianDelta = filteredStats.median24 !== null && netPrice !== null && netPrice !== 0
    ? ((filteredStats.median24 - netPrice) / netPrice) * 100
    : (filteredStats.median24 !== null ? data?.statistics.median_delta_pct ?? null : null);

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

  if (loading) return <section className="article-detail"><LoadingState label="Preisverlauf wird geladen" /></section>;
  if (error && !data) return <section className="article-detail"><InlineNotice tone="error" action={<RetryButton onClick={load} />}>{error}</InlineNotice></section>;
  if (!data) return null;
  const historyColumns = articleHistoryColumns(data.columns);

  return (
    <section className="article-detail">
      <header className="article-detail-header">
        <div><span className="price-kicker">Artikel {articleNumber}</span><h3>{String(data.article.Bezeichnung ?? data.article.description ?? "Ohne Bezeichnung")}</h3><p>Datanorm-Netto {formatCurrency(netPrice)}</p></div>
        <div className="article-export-actions">
          <button className="price-button" type="button" disabled={exporting} onClick={() => void exportArticle("article")}><Download size={16} /> CSV</button>
          <button className="price-button" type="button" disabled={exporting} onClick={() => void exportArticle("article_pdf")}><Download size={16} /> PDF</button>
        </div>
      </header>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <WarningList warnings={data.warnings} />
      <div className="article-controls">
        <div className="price-segmented" aria-label="Diagrammtyp">
          <button type="button" className={chartMode === "bars" ? "is-active" : undefined} onClick={() => setChartMode("bars")}>Balken</button>
          <button type="button" className={chartMode === "line" ? "is-active" : undefined} onClick={() => setChartMode("line")}>Linie</button>
        </div>
        <fieldset className="offer-type-filter"><legend className="sr-only">Angebotsarten</legend>{offerTypes.map((type) => <label key={type}><input type="checkbox" checked={enabledTypes.has(type)} onChange={(event) => setEnabledTypes((current) => {
          const next = new Set(current); if (event.target.checked) next.add(type); else next.delete(type); return next;
        })} /><span>{shortOfferType(type)}</span></label>)}</fieldset>
      </div>
      <div className="price-metrics article-metrics">
        <Metric label="Minimum" value={formatCurrency(filteredStats.minimum)} />
        <Metric label="Median 24 Monate" value={formatCurrency(filteredStats.median24)} hint={medianDelta === null ? undefined : `Zur Datanorm ${formatPercent(medianDelta)}`} />
        <Metric label="Maximum" value={formatCurrency(filteredStats.maximum)} />
        <Metric label="Angebotspreise" value={formatInteger(filteredRows.length)} />
      </div>
      <PriceHistoryChart rows={filteredRows} netPrice={netPrice} medianDelta={medianDelta} mode={chartMode} />
      <div className="article-history-table-wrap">
        <table className="price-table article-history-table"><thead><tr>{historyColumns.map((column) => <th key={column}>{columnLabel(column, "article")}</th>)}</tr></thead><tbody>{filteredRows.map((row, index) => <tr key={`${String(row.Quelle)}-${index}`}>{historyColumns.map((column) => <td key={column} className={cellClass(column, row[column])}>{column === "Quelle" && row[column] ? (
          data.unavailable_sources?.includes(String(row[column]))
            ? <span title="Die Original-PDF ist nicht vorhanden.">{String(row[column])} · Original-PDF fehlt</span>
            : <button className="source-download-button" type="button" onClick={() => void downloadSource(String(row[column]))}>{String(row[column])}<Download size={13} /></button>
        ) : formatCell(column, row[column])}</td>)}</tr>)}</tbody></table>
        {!filteredRows.length ? <p className="compact-empty">Für die ausgewählten Angebotsarten sind keine Preise vorhanden.</p> : null}
      </div>
    </section>
  );
}

function PriceHistoryChart({ rows, netPrice, medianDelta, mode }: { rows: Array<Record<string, unknown>>; netPrice: number | null; medianDelta: number | null; mode: "bars" | "line" }) {
  const points = rows
    .map((row) => ({ price: toNumber(row.Preis), date: String(row.Datum ?? ""), type: String(row.Angebotsart ?? "Erstangebot") as OfferType }))
    .filter((point): point is { price: number; date: string; type: OfferType } => point.price !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  if (!points.length) return <div className="chart-empty">Keine Angebotspreise für das Diagramm.</div>;

  const median24Prices = points.filter((point) => isWithinLastMonths(point.date, 24)).map((point) => point.price);
  const median24 = median24Prices.length ? median(median24Prices) : null;

  const width = 900;
  const height = 310;
  const padding = { top: 24, right: 24, bottom: 50, left: 66 };
  const values = [
    ...points.map((point) => point.price),
    ...(netPrice === null ? [] : [netPrice]),
    ...(median24 === null ? [] : [median24]),
  ];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, Math.max(maximum * 0.12, 1));
  const floor = Math.max(0, minimum - range * 0.16);
  const ceiling = maximum + range * 0.16;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => padding.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) => padding.top + (1 - (value - floor) / (ceiling - floor)) * plotHeight;
  const linePath = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.price)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, index) => floor + ((ceiling - floor) * index) / 4).reverse();
  const barWidth = Math.max(8, Math.min(42, plotWidth / Math.max(points.length, 1) * 0.56));

  return (
    <div className="price-chart-shell">
      <svg className="price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Preisverlauf mit ${points.length} Angebotspreisen`}>
        {ticks.map((tick) => <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} className="chart-grid-line" /><text x={padding.left - 10} y={y(tick) + 4} textAnchor="end" className="chart-axis-label">{formatChartPrice(tick)}</text></g>)}
        {netPrice !== null ? <g><line x1={padding.left} x2={width - padding.right} y1={y(netPrice)} y2={y(netPrice)} className="chart-net-line" /><text x={width - padding.right} y={Math.max(12, y(netPrice) - 7)} textAnchor="end" className="chart-net-label">Datanorm {formatCurrency(netPrice)}</text></g> : null}
        {mode === "line" && median24 !== null ? <g><line x1={padding.left} x2={width - padding.right} y1={y(median24)} y2={y(median24)} className="chart-median-line" /><text x={padding.left + 7} y={Math.max(12, y(median24) - 7)} className="chart-median-label">Median 24 Monate {formatCurrency(median24)}{medianDelta === null ? "" : ` (${formatPercent(medianDelta)})`}</text></g> : null}
        {mode === "line" ? <path d={linePath} className="chart-history-line" /> : null}
        {points.map((point, index) => mode === "bars" ? (
          <g key={`${point.date}-${index}`}><rect x={x(index) - barWidth / 2} y={y(point.price)} width={barWidth} height={padding.top + plotHeight - y(point.price)} rx="2" className={`chart-bar is-${offerTypeClass(point.type)}`}><title>{formatDate(point.date)} · {point.type} · {formatCurrency(point.price)}</title></rect></g>
        ) : (
          <circle key={`${point.date}-${index}`} cx={x(index)} cy={y(point.price)} r="5" className={`chart-point is-${offerTypeClass(point.type)}`}><title>{formatDate(point.date)} · {point.type} · {formatCurrency(point.price)}</title></circle>
        ))}
        {points.map((point, index) => (index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 6)) === 0) ? <text key={`label-${point.date}-${index}`} x={x(index)} y={height - 18} textAnchor="middle" className="chart-axis-label">{shortDate(point.date)}</text> : null)}
      </svg>
      <div className="chart-legend"><span className="is-first">Erstangebot</span><span className="is-follow">Folgeangebot</span><span className="is-negotiated">Verhandelt</span><span className="is-net">Datanorm-Netto</span>{mode === "line" && median24 !== null ? <span className="is-median">Median 24 Monate</span> : null}</div>
    </div>
  );
}

function FilesView({ status, onMutation }: { status: PriceComparisonStatus | null; onMutation: () => Promise<void> }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [data, setData] = useState<FilesResult | null>(null);
  const [search, setSearch] = useState("");
  const [offerFiles, setOfferFiles] = useState<File[]>([]);
  const [datanormFiles, setDatanormFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuildPreview, setRebuildPreview] = useState<RebuildPreview | null>(null);
  const [uploadDuplicatePreview, setUploadDuplicatePreview] = useState<UploadDuplicatePreview | null>(null);
  const offerInputId = useId();
  const datanormInputId = useId();
  const rebuildDialogRef = useRef<HTMLElement | null>(null);
  const uploadDialogRef = useRef<HTMLElement | null>(null);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await priceRequest<FilesResult>("/price-comparison/files");
      if (requestId === loadRequest.current) setData(loaded);
    } catch (loadError) {
      if (requestId === loadRequest.current) setError(errorMessage(loadError));
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!rebuildPreview) return;
    rebuildDialogRef.current?.focus();
  }, [rebuildPreview]);

  useEffect(() => {
    if (!uploadDuplicatePreview) return;
    uploadDialogRef.current?.focus();
  }, [uploadDuplicatePreview]);

  async function upload(kind: PriceFile["kind"], files: File[], confirmation?: Pick<UploadDuplicatePreview, "duplicates" | "revision">) {
    if (!files.length) return;
    setBusy(`upload-${kind}`);
    setError(null);
    const body = new FormData();
    body.append("kind", kind);
    body.append("expected_revision", confirmation?.revision ?? data?.revision ?? status?.revision ?? "");
    files.forEach((file) => body.append("files", file));
    if (confirmation) body.append("confirmed_duplicates", JSON.stringify(confirmation.duplicates.map((duplicate) => duplicate.remove)));
    try {
      await priceRequest("/price-comparison/files", { method: "POST", body });
      if (kind === "offers") setOfferFiles([]); else setDatanormFiles([]);
      setUploadDuplicatePreview(null);
      await load();
      await onMutation();
    } catch (uploadError) {
      const duplicateDetail = duplicateUploadDetail(uploadError);
      if (duplicateDetail) {
        setUploadDuplicatePreview({ kind, files, ...duplicateDetail });
        return;
      }
      if (confirmation) setUploadDuplicatePreview(null);
      setError(mutationErrorMessage(uploadError));
    } finally {
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
    setBusy(`delete-${file.kind}-${file.name}`);
    setError(null);
    try {
      await priceRequest(queryPath(`/price-comparison/files/${file.kind}/${encodeURIComponent(file.name)}`, {
        expected_revision: data?.revision ?? status?.revision,
      }), { method: "DELETE" });
      await load();
      await onMutation();
    } catch (deleteError) {
      setError(mutationErrorMessage(deleteError));
    } finally {
      setBusy(null);
    }
  }

  async function downloadFile(file: PriceFile) {
    setBusy(`download-${file.kind}-${file.name}`);
    setError(null);
    try {
      const download = await priceDownload(`/price-comparison/files/${file.kind}/${encodeURIComponent(file.name)}/download`);
      triggerDownload(download, file.name);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setBusy(null);
    }
  }

  async function runMaintenance(action: "rebuild_offers" | "reparse_datanorm" | "refresh_percentages") {
    if (action === "rebuild_offers") {
      await previewRebuild();
      return;
    }
    setBusy(`maintenance-${action}`);
    setError(null);
    try {
      await priceRequest("/price-comparison/maintenance", {
        method: "POST",
        body: JSON.stringify({ action, expected_revision: data?.revision ?? status?.revision }),
      });
      await load();
      await onMutation();
    } catch (maintenanceError) {
      setError(mutationErrorMessage(maintenanceError));
    } finally {
      setBusy(null);
    }
  }

  async function previewRebuild() {
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
      setBusy(null);
    }
  }

  async function confirmRebuild(preview: RebuildPreview) {
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
      await load();
      await onMutation();
    } catch (rebuildError) {
      setRebuildPreview(null);
      setError(mutationErrorMessage(rebuildError));
    } finally {
      setBusy(null);
    }
  }

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
      {error ? <InlineNotice tone="error" action={<RetryButton onClick={load} />}>{error}</InlineNotice> : null}

      <div className="file-sections">
        <FileSection title="Angebote (PDF)" description="Mehrere Projektangebote können gemeinsam hochgeladen werden." files={offers} loading={loading} busy={busy} inputId={offerInputId} selectedFiles={offerFiles} accept="application/pdf,.pdf" multiple onFiles={setOfferFiles} onUpload={() => upload("offers", offerFiles)} onDownload={downloadFile} onDelete={deleteFile} />
        <FileSection title="Datanorm" description="Die aktive Datanorm bildet die Basis für Netto- und Artikelpreise." files={datanorm} loading={loading} busy={busy} inputId={datanormInputId} selectedFiles={datanormFiles} accept=".dat,.txt,text/plain" multiple onFiles={setDatanormFiles} onUpload={() => upload("datanorm", datanormFiles)} onDownload={downloadFile} onDelete={deleteFile} />
      </div>

      {isAdmin ? (
        <section className="maintenance-panel">
          <div><span className="price-kicker">Nur Administration</span><h3>Datenbestand warten</h3><p>Parser- und Vergleichscaches gezielt aus den gespeicherten Quelldateien erneuern.</p></div>
          <div className="maintenance-actions">
            <button className="price-button" type="button" disabled={Boolean(busy)} onClick={() => void runMaintenance("rebuild_offers")}><RefreshCw size={16} /> Angebote neu aufbauen</button>
            <button className="price-button" type="button" disabled={Boolean(busy)} onClick={() => void runMaintenance("reparse_datanorm")}><RefreshCw size={16} /> Datanorm neu einlesen</button>
            <button className="price-button" type="button" disabled={Boolean(busy)} onClick={() => void runMaintenance("refresh_percentages")}><RefreshCw size={16} /> Prozentwerte aktualisieren</button>
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
      {uploadDuplicatePreview ? (
        <div className="price-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setUploadDuplicatePreview(null);
        }}>
          <section ref={uploadDialogRef} className="price-modal" role="dialog" aria-modal="true" aria-labelledby="upload-duplicate-title" tabIndex={-1} onKeyDown={(event) => {
            if (event.key === "Escape") setUploadDuplicatePreview(null);
          }}>
            <header><div><span className="price-kicker">Bestätigung erforderlich</span><h3 id="upload-duplicate-title">{uploadDuplicatePreview.kind === "offers" ? "Vorhandene Angebote ersetzen" : "Vorhandene Datanorm ersetzen"}</h3></div><button className="price-icon-button" type="button" aria-label="Dialog schließen" onClick={() => setUploadDuplicatePreview(null)}><X size={18} /></button></header>
            <p>{uploadDuplicatePreview.message || (uploadDuplicatePreview.kind === "offers" ? "Die hochgeladenen Dateien enthalten bereits vorhandene Angebotsnummern. Die neuen Dateien bleiben erhalten; die aufgeführten älteren Dateien werden nur nach Ihrer Bestätigung gelöscht." : "Eine Datanorm-Datei mit diesem Namen ist bereits vorhanden und wird nur nach Ihrer Bestätigung ersetzt.")}</p>
            <div className="duplicate-preview-list">{uploadDuplicatePreview.duplicates.map((duplicate) => <div key={`${duplicate.offer_number}-${duplicate.remove}`}><strong>{duplicate.offer_number === "DATANORM" ? "Datanorm-Datei" : `Angebot ${duplicate.offer_number || "ohne Nummer"}`}</strong><span><Check size={14} /> Behalten: {duplicate.keep}</span><span className="is-remove"><Trash2 size={14} /> Löschen: {duplicate.remove}</span></div>)}</div>
            <footer><button className="price-button" type="button" onClick={() => setUploadDuplicatePreview(null)}>Abbrechen</button><button className="price-button is-danger" type="button" disabled={Boolean(busy)} onClick={() => void upload(uploadDuplicatePreview.kind, uploadDuplicatePreview.files, uploadDuplicatePreview)}><Trash2 size={16} /> Ersetzen und hochladen</button></footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function FileSection({ title, description, files, loading, busy, inputId, selectedFiles, accept, multiple, onFiles, onUpload, onDownload, onDelete }: {
  title: string;
  description: string;
  files: PriceFile[];
  loading: boolean;
  busy: string | null;
  inputId: string;
  selectedFiles: File[];
  accept: string;
  multiple: boolean;
  onFiles: (files: File[]) => void;
  onUpload: () => void;
  onDownload: (file: PriceFile) => void;
  onDelete: (file: PriceFile) => void;
}) {
  return (
    <section className="file-section">
      <header><div><h3>{title}</h3><p>{description}</p></div><span>{formatInteger(files.length)} {files.some((file) => file.original_available === false) ? "Einträge" : "Dateien"}</span></header>
      <div className="file-upload-row">
        <input key={selectedFiles.map((file) => `${file.name}-${file.size}-${file.lastModified}`).join("|") || "empty"} id={inputId} className="sr-only" type="file" accept={accept} multiple={multiple} onChange={(event) => onFiles(Array.from(event.target.files ?? []))} />
        <label className="price-button" htmlFor={inputId}><Plus size={16} /> Dateien auswählen</label>
        <span title={selectedFiles.map((file) => file.name).join(", ")}>{selectedFiles.length ? `${selectedFiles.length} ausgewählt` : "Keine Auswahl"}</span>
        <button className="price-button is-primary" type="button" disabled={!selectedFiles.length || Boolean(busy)} onClick={onUpload}>{busy?.startsWith("upload-") ? <LoaderCircle className="is-spinning" size={16} /> : <Upload size={16} />} Hochladen</button>
      </div>
      {loading ? <LoadingState label={`${title} werden geladen`} compact /> : files.length ? (
        <div className="file-list">{files.map((file) => {
          return <div className="file-list-item" key={`${file.kind}-${file.name}`}>
            <FileText size={18} aria-hidden="true" />
            <div><strong>{file.name}</strong><span>{file.original_available === false ? "Positionen erhalten · Original-PDF fehlt" : `${formatFileSize(file.size)} · ${formatDateTime(file.modified)}`}</span>{file.included_in_comparison === false ? <span>Im übernommenen Online-Vergleich nicht enthalten</span> : null}</div>
            {file.active ? <span className="active-file-badge"><Check size={13} /> Aktiv</span> : null}
            <div className="file-actions"><button className="price-icon-button" type="button" title={file.original_available === false ? "Die Original-PDF ist nicht vorhanden." : "Herunterladen"} aria-label={`${file.name} herunterladen`} disabled={Boolean(busy) || file.original_available === false} onClick={() => onDownload(file)}><Download size={16} /></button><button className="price-icon-button is-danger" type="button" title="Löschen" aria-label={`${file.name} löschen`} disabled={Boolean(busy)} onClick={() => onDelete(file)}><Trash2 size={16} /></button></div>
          </div>;
        })}</div>
      ) : <p className="compact-empty">Keine Dateien vorhanden.</p>}
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
  if (loading) return <div className="price-data-panel"><LoadingState label="Daten werden geladen" /></div>;
  if (empty) return <div className="price-data-panel"><div className="price-empty-state"><FileSpreadsheet size={26} /><strong>Keine Daten</strong><span>{emptyText}</span></div></div>;
  return <div className="price-data-panel">{children}</div>;
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
  const renderedColumns = tableColumns(columns, variant);
  return <div className={`price-table-wrap is-${variant}`}><table className="price-table"><thead><tr>{renderedColumns.map((column) => <th key={column}>{columnLabel(column, variant)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{renderedColumns.map((column) => {
    const value = row[column];
    const offerPriceMatch = column.match(/^Angebotspreis\s+(\d+)$/i);
    const source = offerPriceMatch ? String(row[`AP${offerPriceMatch[1]}_src`] ?? (offerPriceMatch[1] === "1" ? row.AP_best_src ?? "" : "")) : "";
    const content = column === "Artikelnummer" && value && onArticle
      ? <button className="table-link-button" type="button" onClick={() => onArticle(String(value))}>{String(value)}</button>
      : offerPriceMatch && value !== null && value !== undefined && source && onSource
        ? unavailableSources.includes(source)
          ? <span title={`${source}: Die Original-PDF ist nicht vorhanden.`}>{formatCell(column, value)}</span>
          : <button className="table-link-button is-price" type="button" title={`${source} herunterladen`} onClick={() => void onSource(source)}>{formatCell(column, value)}<Download size={12} /></button>
        : formatCell(column, value);
    const classes = [cellClass(column, value), comparisonCellClass(column, value, row)].filter(Boolean).join(" ") || undefined;
    return <td key={column} className={classes}>{content}</td>;
  })}</tr>)}</tbody></table></div>;
}

function Pagination({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + limit, total);
  return <div className="price-pagination" aria-label="Seitennavigation"><span>{formatInteger(start)}–{formatInteger(end)} von {formatInteger(total)}</span><div><button className="price-icon-button" type="button" aria-label="Vorherige Seite" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft size={17} /></button><button className="price-icon-button" type="button" aria-label="Nächste Seite" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}><ChevronRight size={17} /></button></div></div>;
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
  const preferred = ["Datum", "Preis", "Menge", "Quelle", "Projekt", "Angebot", "Angebotsart", "Gesamt (netto)"];
  const selected = preferred.filter((column) => columns.includes(column));
  return selected.length ? selected : visibleColumns(columns).slice(0, 10);
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
    return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(value);
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
  return value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value);
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(value)} %`;
}

function formatDecimal(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("de-DE").format(date);
}

function shortDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : new Intl.DateTimeFormat("de-DE", { month: "2-digit", year: "2-digit" }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 ** 2).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
}

function formatChartPrice(value: number): string {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value)} €`;
}
