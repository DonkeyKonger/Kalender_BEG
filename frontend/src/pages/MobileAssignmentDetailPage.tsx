import {
  ArrowLeft,
  CalendarClock,
  ClipboardList,
  FolderOpen,
  Hammer,
  MapPin,
  Package,
  Plus,
  ReceiptText,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";
import type { MobileMeasurementBatch, MobileMeasurementItem } from "../types/site";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";

type MobileDetailTab = "overview" | "folders" | "measurement" | "tools";
type MeasurementFilter = "all" | "open" | "edited" | "mine" | "approved";
type MeasurementViewMode = "list" | "table";

const MEASUREMENT_VIEW_MODE_STORAGE_KEY = "beg_aufmass_view_mode";

type LocationState = {
  assignment?: MobileAssignment;
};

const detailTabs: Array<{ key: MobileDetailTab; label: string; description: string; icon: typeof ClipboardList }> = [
  { key: "overview", label: "Übersicht", description: "Adresse, Kunde und Projektleiter", icon: ClipboardList },
  { key: "folders", label: "Ordner", description: "Projektordner vorbereitet", icon: FolderOpen },
  { key: "measurement", label: "Aufmaß", description: "Pakete und Positionen erfassen", icon: ReceiptText },
  { key: "tools", label: "Werkzeuge & Material", description: "Status später verfügbar", icon: Package },
];

const measurementFilters: Array<{ key: MeasurementFilter; label: string }> = [
  { key: "all", label: "Alle" },
  { key: "open", label: "Offen" },
  { key: "edited", label: "Bearbeitet" },
  { key: "mine", label: "Meine Meldungen" },
  { key: "approved", label: "Freigegeben" },
];

export function MobileAssignmentDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { assignmentId } = useParams();
  const [activeTab, setActiveTab] = useState<MobileDetailTab>("overview");
  const [isMeasurementEntryMode, setIsMeasurementEntryMode] = useState(false);

  const assignment = useMemo(() => {
    const stateAssignment = (location.state as LocationState | null)?.assignment;
    if (stateAssignment) {
      return stateAssignment;
    }
    return findCachedAssignment(assignmentId);
  }, [assignmentId, location.state]);

  if (!assignment) {
    return (
      <section className="mobile-page mobile-detail-page">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="empty-panel">Dieser Einsatz konnte nicht aus dem lokalen Verlauf geladen werden.</div>
      </section>
    );
  }

  const isMeasurementFlow = activeTab === "measurement";
  const isFocusedEntry = isMeasurementFlow && isMeasurementEntryMode;

  return (
    <section className={`mobile-page mobile-detail-page${isFocusedEntry ? " is-entry-mode" : ""}`}>
      {!isMeasurementFlow ? (
        <>
          <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
            <ArrowLeft aria-hidden="true" size={17} />
            <span>Zurück</span>
          </button>

          <header className="mobile-detail-hero mobile-detail-summary">
            <div className="assignment-card-main">
              <div>
                <h1>{assignment.site.name}</h1>
                <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
              </div>
              <SiteStatusBadge status={assignment.site.status} />
            </div>
            <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatAssignmentRange(assignment)}</p>
          </header>

          <div className="mobile-detail-actions" aria-label="Baustellendetails">
            {detailTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  className={activeTab === tab.key ? "is-active" : ""}
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.key);
                    if (tab.key !== "measurement") {
                      setIsMeasurementEntryMode(false);
                    }
                  }}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>
                    <strong>{tab.label}</strong>
                    <small>{tab.description}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      {activeTab === "overview" && <OverviewPanel assignment={assignment} />}
      {activeTab === "folders" && <PlaceholderPanel icon={FolderOpen} text="Diese Funktion ist vorbereitet und wird später aktiviert." />}
      {activeTab === "measurement" && (
        <MobileMeasurementTab
          assignment={assignment}
          onBackToProject={() => {
            setIsMeasurementEntryMode(false);
            setActiveTab("overview");
          }}
          onEntryModeChange={setIsMeasurementEntryMode}
        />
      )}
      {activeTab === "tools" && <PlaceholderPanel icon={Hammer} text="Werkzeuge & Material wird später Wagen-, Werkzeug- und Materialinformationen anzeigen." />}
    </section>
  );
}

function OverviewPanel({ assignment }: { assignment: MobileAssignment }) {
  return (
    <div className="mobile-detail-panel">
      <h2>Übersicht</h2>
      <div className="assignment-detail-list">
        {(assignment.site.location || assignment.site.address) && (
          <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
        )}
        {assignment.site.project_manager && (
          <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
        )}
        {assignment.site.customer && (
          <p><ClipboardList aria-hidden="true" size={16} /><span>Kunde: {assignment.site.customer}</span></p>
        )}
      </div>
      {assignment.site.info && <p className="assignment-note">{assignment.site.info}</p>}
      {assignment.note && <p className="assignment-note">{assignment.note}</p>}
    </div>
  );
}

function MobileMeasurementTab({
  assignment,
  onBackToProject,
  onEntryModeChange,
}: {
  assignment: MobileAssignment;
  onBackToProject: () => void;
  onEntryModeChange?: (isActive: boolean) => void;
}) {
  const { user } = useAuth();
  const [batches, setBatches] = useState<MobileMeasurementBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<MobileMeasurementBatch | null>(null);
  const [items, setItems] = useState<MobileMeasurementItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<MobileMeasurementItem | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<MeasurementFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isItemsLoading, setIsItemsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formComment, setFormComment] = useState("");
  const [formQuantity, setFormQuantity] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MeasurementViewMode>(() => readMeasurementViewMode());

  async function loadBatches(selectBatchId?: number): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.mobileMeasurementBatches(assignment.id);
      setBatches(response);
      if (selectBatchId) {
        const batch = response.find((item) => item.id === selectBatchId) ?? null;
        setSelectedBatch(batch);
      }
    } catch (requestError) {
      setError(readApiError(requestError, "Aufmaße konnten nicht geladen werden."));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadBatchItems(batch: MobileMeasurementBatch, selectItemId?: number): Promise<void> {
    setIsItemsLoading(true);
    setError(null);
    setSearchTerm("");
    setFilter("all");
    try {
      const response = await api.mobileMeasurementBatchItems(assignment.id, batch.id);
      setItems(response);
      setSelectedItem(selectItemId ? response.find((item) => item.id === selectItemId) ?? null : null);
    } catch (requestError) {
      setError(readApiError(requestError, "Aufmaßpositionen konnten nicht geladen werden."));
    } finally {
      setIsItemsLoading(false);
    }
  }

  useEffect(() => {
    void loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  function updateViewMode(mode: MeasurementViewMode): void {
    setViewMode(mode);
    persistMeasurementViewMode(mode);
  }

  const filteredItems = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const matchesSearch = !needle
        || item.position.toLowerCase().includes(needle)
        || item.description.toLowerCase().includes(needle)
        || (item.unit ?? "").toLowerCase().includes(needle);
      const matchesFilter = filter === "all"
        || (filter === "mine" && item.entries.some((entry) => entry.created_by_user_id === user?.id))
        || (filter === "open" && item.mobile_status === "open")
        || (filter === "edited" && item.mobile_status === "edited")
        || (filter === "approved" && item.mobile_status === "approved");
      return matchesSearch && matchesFilter;
    });
  }, [filter, items, searchTerm, user?.id]);

  useEffect(() => {
    onEntryModeChange?.(Boolean(selectedBatch && selectedItem));
    return () => onEntryModeChange?.(false);
  }, [onEntryModeChange, selectedBatch, selectedItem]);

  if (selectedBatch && selectedItem) {
    return (
      <MeasurementDetail
        batch={selectedBatch}
        item={selectedItem}
        isSaving={isSaving}
        formComment={formComment}
        formQuantity={formQuantity}
        formError={formError}
        onBack={() => {
          setSelectedItem(null);
          setFormError(null);
        }}
        onCommentChange={setFormComment}
        onQuantityChange={setFormQuantity}
        onCancelForm={() => {
          setFormComment("");
          setFormQuantity("");
          setFormError(null);
        }}
        onSave={async () => {
          const quantity = Number(formQuantity.replace(",", "."));
          const normalizedArea = normalizeMeasurementArea(formComment);
          if (!Number.isFinite(quantity) || quantity <= 0) {
            setFormError("Bitte eine gültige Menge größer 0 eingeben.");
            return;
          }
          if (!normalizedArea) {
            setFormError("Bitte Bereich oder Kommentar angeben.");
            return;
          }
          setIsSaving(true);
          setFormError(null);
          try {
            await api.createMobileMeasurementEntry(assignment.id, selectedBatch.id, selectedItem.id, {
              area_or_comment: normalizedArea,
              quantity,
            });
            setFormComment("");
            setFormQuantity("");
            await loadBatches(selectedBatch.id);
            await loadBatchItems(selectedBatch, selectedItem.id);
          } catch (requestError) {
            setFormError(readApiError(requestError, "Aufmaßzeile konnte nicht gespeichert werden."));
          } finally {
            setIsSaving(false);
          }
        }}
      />
    );
  }

  if (selectedBatch) {
    return (
      <MeasurementBatchDetail
        batch={selectedBatch}
        items={filteredItems}
        allItems={items}
        isItemsLoading={isItemsLoading}
        error={error}
        searchTerm={searchTerm}
        filter={filter}
        onBack={() => {
          setSelectedBatch(null);
          setSelectedItem(null);
          setItems([]);
          setError(null);
        }}
        viewMode={viewMode}
        onViewModeChange={updateViewMode}
        onSearchChange={setSearchTerm}
        onFilterChange={setFilter}
        onSelectItem={(item) => {
          setSelectedItem(item);
          setFormComment("");
          setFormQuantity("");
          setFormError(null);
        }}
        onSubmit={async () => {
          setIsSaving(true);
          setError(null);
          try {
            const submitted = await api.submitMobileMeasurementBatch(assignment.id, selectedBatch.id);
            await loadBatches(submitted.id);
            setSelectedBatch(submitted);
          } catch (requestError) {
            setError(readApiError(requestError, "Aufmaß konnte nicht gesendet werden."));
          } finally {
            setIsSaving(false);
          }
        }}
        isSaving={isSaving}
      />
    );
  }

  return (
    <div className="mobile-measurement-page mobile-measurement-panel">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBackToProject}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Projektakte</span>
      </button>

      <div className="mobile-panel-title-row">
        <div className="mobile-measurement-page-title">
          <h1>Aufmaße</h1>
          <p>{[assignment.site.site_number, assignment.site.name].filter(Boolean).join(" · ")}</p>
        </div>
        <button
          className="primary-action"
          type="button"
          onClick={async () => {
            setIsSaving(true);
            setError(null);
            try {
              const batch = await api.createMobileMeasurementBatch(assignment.id);
              await loadBatches(batch.id);
              setSelectedBatch(batch);
              await loadBatchItems(batch);
            } catch (requestError) {
              setError(readApiError(requestError, "Aufmaß konnte nicht erstellt werden."));
            } finally {
              setIsSaving(false);
            }
          }}
          disabled={isSaving}
        >
          <Plus aria-hidden="true" size={15} />
          <span>{isSaving ? "Erstelle..." : "Neues Aufmaß"}</span>
        </button>
      </div>

      {isLoading ? <div className="empty-panel">Aufmaße werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isLoading && !error && batches.length === 0 ? (
        <div className="empty-panel">Noch kein Aufmaß vorhanden.</div>
      ) : null}
      {!isLoading && batches.length > 0 ? (
        <div className="mobile-measurement-list">
          {batches.map((batch) => (
            <button
              className="mobile-measurement-card"
              key={batch.id}
              type="button"
              onClick={() => {
                setSelectedBatch(batch);
                void loadBatchItems(batch);
              }}
            >
              <span className={`measurement-status mobile-status-${batch.status}`}>{batchStatusLabel(batch.status)}</span>
              <strong>{batch.title}</strong>
              <span>{batch.position_count} Positionen / {batch.entry_count} Aufmaßzeilen</span>
              <small>Summe: {formatMeasurementNumber(batch.reported_hours)} Sollstunden</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MeasurementBatchDetail({
  batch,
  items,
  allItems,
  isItemsLoading,
  error,
  searchTerm,
  filter,
  isSaving,
  viewMode,
  onBack,
  onViewModeChange,
  onSearchChange,
  onFilterChange,
  onSelectItem,
  onSubmit,
}: {
  batch: MobileMeasurementBatch;
  items: MobileMeasurementItem[];
  allItems: MobileMeasurementItem[];
  isItemsLoading: boolean;
  error: string | null;
  searchTerm: string;
  filter: MeasurementFilter;
  isSaving: boolean;
  viewMode: MeasurementViewMode;
  onBack: () => void;
  onViewModeChange: (mode: MeasurementViewMode) => void;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: MeasurementFilter) => void;
  onSelectItem: (item: MobileMeasurementItem) => void;
  onSubmit: () => void;
}) {
  const isDraft = batch.status === "draft";
  return (
    <div className="mobile-detail-panel mobile-measurement-panel">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Aufmaße</span>
      </button>

      <div className="mobile-measurement-detail-head">
        <span className={`measurement-status mobile-status-${batch.status}`}>{batchStatusLabel(batch.status)}</span>
        <h2>{batch.title}</h2>
        <p>{batch.position_count} Positionen / {batch.entry_count} Aufmaßzeilen · {formatMeasurementNumber(batch.reported_hours)} Sollstunden</p>
      </div>

      {isDraft ? (
        <button className="primary-action" type="button" onClick={onSubmit} disabled={isSaving || batch.entry_count === 0}>
          <Send aria-hidden="true" size={15} />
          <span>{isSaving ? "Sende..." : "Zur Prüfung senden"}</span>
        </button>
      ) : (
        <p className="form-info">Dieses Aufmaß wurde zur Prüfung gesendet und ist mobil schreibgeschützt.</p>
      )}

      <div className="mobile-measurement-search">
        <Search aria-hidden="true" size={17} />
        <input
          type="search"
          placeholder="Position oder Leistung suchen..."
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="mobile-filter-row" role="group" aria-label="Aufmaßfilter">
        {measurementFilters.map((item) => (
          <button
            className={filter === item.key ? "active" : ""}
            key={item.key}
            type="button"
            onClick={() => onFilterChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <MeasurementViewToggle viewMode={viewMode} onChange={onViewModeChange} />

      {isItemsLoading ? <div className="empty-panel">Aufmaßpositionen werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isItemsLoading && !error && allItems.length === 0 ? (
        <div className="empty-panel">Noch keine Aufmaßpositionen importiert.</div>
      ) : null}
      {!isItemsLoading && !error && allItems.length > 0 && items.length === 0 ? (
        <div className="empty-panel">Keine Aufmaßposition gefunden.</div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 && viewMode === "list" ? (
        <div className="mobile-measurement-list">
          {items.map((item) => (
            <button className="mobile-measurement-card" key={item.id} type="button" onClick={() => onSelectItem(item)}>
              <div className="mobile-measurement-row-top">
                <span className={`measurement-status ${mobilePositionStatusClass(item)}`}>{mobilePositionStatusLabel(item)}</span>
                <strong className="mobile-measurement-row-quantity">{formatMeasurementNumber(item.reported_quantity)} {item.unit ?? ""}</strong>
              </div>
              <strong className="mobile-measurement-row-position">{item.position}</strong>
              <span className="mobile-measurement-row-description">{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 && viewMode === "table" ? (
        <MobileMeasurementTable items={items} onSelectItem={onSelectItem} />
      ) : null}
    </div>
  );
}

function MeasurementViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: MeasurementViewMode;
  onChange: (mode: MeasurementViewMode) => void;
}) {
  return (
    <div className="measurement-view-toggle" role="group" aria-label="Aufmaß Ansicht">
      <button className={viewMode === "list" ? "is-active" : ""} type="button" onClick={() => onChange("list")}>Liste</button>
      <button className={viewMode === "table" ? "is-active" : ""} type="button" onClick={() => onChange("table")}>Tabelle</button>
    </div>
  );
}

function MobileMeasurementTable({
  items,
  onSelectItem,
}: {
  items: MobileMeasurementItem[];
  onSelectItem: (item: MobileMeasurementItem) => void;
}) {
  const areaRows = collectMeasurementAreaTags(items);

  return (
    <div className="mobile-measurement-table-wrap" role="region" aria-label="Tabellarische Aufmaßaufstellung">
      <table className="measurement-table-view measurement-matrix-table mobile-measurement-table">
        <thead>
          <tr>
            <th className="measurement-matrix-axis">Pos.-Nr.</th>
            {items.map((item) => (
              <th className="measurement-matrix-position-heading" key={item.id}>
                <button className="measurement-matrix-header-button" type="button" onClick={() => onSelectItem(item)}>
                  {item.position}
                </button>
              </th>
            ))}
          </tr>
          <tr>
            <th className="measurement-matrix-axis">Beschreibung</th>
            {items.map((item) => (
              <th className="measurement-matrix-description-heading" key={item.id}>{item.description}</th>
            ))}
          </tr>
          <tr>
            <th className="measurement-matrix-axis">Einheit</th>
            {items.map((item) => (
              <th key={item.id}>{item.unit ?? "-"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="measurement-matrix-section-row">
            <th className="measurement-matrix-axis">Bauteil / Ort</th>
            {items.map((item) => <td key={item.id} />)}
          </tr>
          {areaRows.map((area) => (
            <tr key={area}>
              <th className="measurement-matrix-axis">{area}</th>
              {items.map((item) => {
                const quantity = getMobileMeasurementAreaQuantity(item, area);
                return (
                  <td className={quantity > 0 ? "measurement-matrix-quantity-cell" : "measurement-matrix-empty-cell"} key={item.id}>
                    <button className="measurement-matrix-cell-button" type="button" onClick={() => onSelectItem(item)}>
                      {quantity > 0 ? formatMeasurementNumber(quantity) : ""}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="measurement-matrix-total-row">
            <th className="measurement-matrix-axis">Gesamt</th>
            {items.map((item) => (
              <td className="measurement-matrix-quantity-cell" key={item.id}>
                <button className="measurement-matrix-cell-button" type="button" onClick={() => onSelectItem(item)}>
                  <strong>{formatMeasurementNumber(item.reported_quantity)}</strong>
                </button>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MeasurementDetail({
  batch,
  item,
  isSaving,
  formComment,
  formQuantity,
  formError,
  onBack,
  onCancelForm,
  onCommentChange,
  onQuantityChange,
  onSave,
}: {
  batch: MobileMeasurementBatch;
  item: MobileMeasurementItem;
  isSaving: boolean;
  formComment: string;
  formQuantity: string;
  formError: string | null;
  onBack: () => void;
  onCancelForm: () => void;
  onCommentChange: (value: string) => void;
  onQuantityChange: (value: string) => void;
  onSave: () => void;
}) {
  const isDraft = batch.status === "draft";
  const areaInputRef = useRef<HTMLInputElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isDraft) {
      return;
    }
    let timeoutId: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        quantityInputRef.current?.focus({ preventScroll: true });
      }, 80);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isDraft, item.id]);

  return (
    <div className="mobile-measurement-entry-page">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Positionen</span>
      </button>

      <header className="mobile-entry-head">
        <div>
          <span className={`measurement-status mobile-status-${item.mobile_status}`}>{mobileStatusLabel(item.mobile_status)}</span>
          <h1>Pos. {item.position}</h1>
          <p>{item.description}</p>
        </div>
        <div className="mobile-entry-facts">
          <span>Einheit <strong>{item.unit ?? "-"}</strong></span>
          <span>Gemeldet <strong>{formatMeasurementNumber(item.reported_quantity)} {item.unit ?? ""}</strong></span>
        </div>
      </header>

      {isDraft ? (
        <div className="mobile-measurement-form mobile-measurement-entry-form">
          <div className="mobile-measurement-form-grid">
            <label>
              <span>Bereich / Ort</span>
              <input
                ref={areaInputRef}
                value={formComment}
                onChange={(event) => onCommentChange(event.target.value)}
                placeholder="z. B. 1. OG"
              />
            </label>
            <label>
              <span>Menge ({item.unit ?? "Einheit"})</span>
              <input
                ref={quantityInputRef}
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={formQuantity}
                onChange={(event) => onQuantityChange(event.target.value)}
              />
            </label>
          </div>

          {formError ? <p className="form-error">{formError}</p> : null}
          <div className="mobile-form-actions">
            <button className="secondary-action" type="button" onClick={onCancelForm} disabled={isSaving}>Leeren</button>
            <button className="primary-action" type="button" onClick={onSave} disabled={isSaving}>{isSaving ? "Speichern..." : "Speichern"}</button>
          </div>
        </div>
      ) : (
        <p className="form-info">Dieses Aufmaß ist nicht mehr im Entwurf. Neue Aufmaßzeilen sind gesperrt.</p>
      )}

      <div className="mobile-measurement-entries">
        <div className="mobile-panel-title-row">
          <h3>Bisher erfasst</h3>
        </div>

        {item.entries.length === 0 ? <p className="empty-inline">Noch keine Aufmaßzeilen erfasst.</p> : null}
        {item.entries.map((entry) => (
          <article className="mobile-measurement-entry" key={entry.id}>
            <strong>{entry.area_or_comment}</strong>
            <span>{formatMeasurementNumber(entry.quantity)} {item.unit ?? ""}</span>
          </article>
        ))}
      </div>

      <details className="mobile-measurement-secondary-details">
        <summary>Details anzeigen</summary>
        <div>
          <span>Paket <strong>{batch.title}</strong></span>
          <span>Min/Einh. <strong>{formatMeasurementNumber(item.minutes_per_unit)}</strong></span>
          <span>Menge Liste <strong>{formatMeasurementNumber(item.list_quantity)}</strong></span>
          <span>Minuten <strong>{formatMeasurementNumber(item.reported_minutes)}</strong></span>
          <span>Stunden <strong>{formatMeasurementNumber(item.reported_hours)}</strong></span>
        </div>
      </details>
    </div>
  );
}

function PlaceholderPanel({ icon: Icon, text }: { icon: typeof ClipboardList; text: string }) {
  return (
    <div className="mobile-detail-panel mobile-placeholder-panel">
      <Icon aria-hidden="true" size={22} />
      <p>{text}</p>
    </div>
  );
}

function findCachedAssignment(assignmentId: string | undefined): MobileAssignment | null {
  if (!assignmentId) {
    return null;
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const cache = JSON.parse(raw) as { data?: MobileAssignmentsResponse };
    return cache.data?.assignments.find((item) => String(item.id) === assignmentId) ?? null;
  } catch {
    return null;
  }
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message || fallback;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function readMeasurementViewMode(): MeasurementViewMode {
  if (typeof window === "undefined") {
    return "list";
  }
  return window.localStorage.getItem(MEASUREMENT_VIEW_MODE_STORAGE_KEY) === "table" ? "table" : "list";
}

function persistMeasurementViewMode(mode: MeasurementViewMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(MEASUREMENT_VIEW_MODE_STORAGE_KEY, mode);
}

function collectMeasurementAreaTags(items: MobileMeasurementItem[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  items.forEach((item) => {
    item.entries.forEach((entry) => {
      const normalized = normalizeMeasurementArea(entry.area_or_comment);
      const key = getMeasurementAreaKey(normalized);
      if (!normalized || seen.has(key)) {
        return;
      }
      seen.add(key);
      tags.push(normalized);
    });
  });

  return sortMeasurementAreaLabels(tags);
}

function sortMeasurementAreaLabels(labels: string[]): string[] {
  return labels
    .map((label, index) => ({ label, index, sortRank: getMeasurementAreaSortRank(label, index) }))
    .sort((left, right) => left.sortRank - right.sortRank || left.index - right.index)
    .map((item) => item.label);
}

function getMobileMeasurementAreaQuantity(item: MobileMeasurementItem, areaLabel: string): number {
  const areaKey = getMeasurementAreaKey(areaLabel);
  return item.entries.reduce((sum, entry) => {
    if (getMeasurementAreaKey(entry.area_or_comment) !== areaKey) {
      return sum;
    }
    const quantity = typeof entry.quantity === "number" ? entry.quantity : Number(entry.quantity);
    return Number.isFinite(quantity) ? sum + quantity : sum;
  }, 0);
}

function normalizeMeasurementArea(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "";
  }

  const upper = trimmed.toUpperCase();
  if (["EG", "UG", "DG"].includes(upper)) {
    return upper;
  }
  if (upper === "DACH") {
    return "Dach";
  }

  const floorMatch = trimmed.match(/^(\d+)\s*\.?\s*og$/i);
  if (floorMatch) {
    return `${Number(floorMatch[1])}. OG`;
  }

  return trimmed;
}

function getMeasurementAreaKey(value: string): string {
  return normalizeMeasurementArea(value).toLocaleLowerCase("de-DE");
}

function getMeasurementAreaSortRank(label: string, fallbackIndex: number): number {
  const normalized = normalizeMeasurementArea(label);
  const upper = normalized.toUpperCase();
  if (upper === "UG") {
    return 0;
  }
  if (upper === "EG") {
    return 10;
  }
  const floorMatch = upper.match(/^(\d+)\. OG$/);
  if (floorMatch) {
    return 20 + Number(floorMatch[1]);
  }
  if (upper === "DG") {
    return 900;
  }
  if (upper === "DACH") {
    return 910;
  }
  if (upper.includes("AUSSEN") || upper.includes("AUßEN")) {
    return 920;
  }
  return 1000 + fallbackIndex;
}

function formatRangeLabel(start: string, end: string): string {
  return `${formatDate(start)} bis ${formatDate(end)}`;
}

function formatAssignmentRange(assignment: MobileAssignment): string {
  return assignment.start_date === assignment.end_date
    ? formatDate(assignment.start_date)
    : formatRangeLabel(assignment.start_date, assignment.end_date);
}

function formatMeasurementNumber(value: string | number | null): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric);
}

function batchStatusLabel(status: string): string {
  if (status === "submitted") {
    return "Zur Prüfung gesendet";
  }
  if (status === "approved") {
    return "Freigegeben";
  }
  if (status === "rejected") {
    return "Zurückgewiesen";
  }
  if (status === "closed") {
    return "Abgeschlossen";
  }
  return "Entwurf";
}

function mobileStatusLabel(status: string): string {
  if (["approved", "billed", "edited"].includes(status)) {
    return "Erfasst";
  }
  return "Offen";
}

function mobilePositionStatusLabel(item: MobileMeasurementItem): string {
  return isMobileMeasurementItemCaptured(item) ? "Erfasst" : "Offen";
}

function mobilePositionStatusClass(item: MobileMeasurementItem): string {
  return isMobileMeasurementItemCaptured(item) ? "mobile-status-edited" : "mobile-status-open";
}

function isMobileMeasurementItemCaptured(item: MobileMeasurementItem): boolean {
  const reportedQuantity = Number(item.reported_quantity);
  return item.entries.length > 0 || (Number.isFinite(reportedQuantity) && reportedQuantity > 0);
}
