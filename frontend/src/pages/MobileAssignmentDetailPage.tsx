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
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";
import type { MobileMeasurementBatch, MobileMeasurementItem } from "../types/site";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";

type MobileDetailTab = "overview" | "time" | "folders" | "measurement" | "tools";
type MeasurementFilter = "all" | "open" | "edited" | "mine" | "approved";

type LocationState = {
  assignment?: MobileAssignment;
};

const detailTabs: Array<{ key: MobileDetailTab; label: string; icon: typeof ClipboardList }> = [
  { key: "overview", label: "Übersicht", icon: ClipboardList },
  { key: "time", label: "Lohnerfassung", icon: CalendarClock },
  { key: "folders", label: "Ordnerstruktur", icon: FolderOpen },
  { key: "measurement", label: "Aufmaß", icon: ReceiptText },
  { key: "tools", label: "Werkzeuge & Material", icon: Package },
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

  return (
    <section className="mobile-page mobile-detail-page">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Zurück</span>
      </button>

      <header className="mobile-detail-hero assignment-card">
        <div className="assignment-card-main">
          <div>
            <p className="eyebrow">Baustelle</p>
            <h1>{assignment.site.name}</h1>
            <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
          </div>
          <SiteStatusBadge status={assignment.site.status} />
        </div>
        <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatAssignmentRange(assignment)}</p>
      </header>

      <nav className="mobile-detail-tabs" aria-label="Baustellendetails">
        {detailTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              className={activeTab === tab.key ? "active" : ""}
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon aria-hidden="true" size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {activeTab === "overview" && <OverviewPanel assignment={assignment} />}
      {activeTab === "time" && <PlaceholderPanel icon={CalendarClock} text="Lohnerfassung wird vorbereitet." />}
      {activeTab === "folders" && <PlaceholderPanel icon={FolderOpen} text="Ordnerstruktur wird vorbereitet." />}
      {activeTab === "measurement" && <MobileMeasurementTab assignment={assignment} />}
      {activeTab === "tools" && <PlaceholderPanel icon={Hammer} text="Werkzeuge & Material wird vorbereitet." />}
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

function MobileMeasurementTab({ assignment }: { assignment: MobileAssignment }) {
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
          if (!Number.isFinite(quantity) || quantity <= 0) {
            setFormError("Bitte eine gültige Menge größer 0 eingeben.");
            return;
          }
          if (!formComment.trim()) {
            setFormError("Bitte Bereich oder Kommentar angeben.");
            return;
          }
          setIsSaving(true);
          setFormError(null);
          try {
            await api.createMobileMeasurementEntry(assignment.id, selectedBatch.id, selectedItem.id, {
              area_or_comment: formComment.trim(),
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
        onSearchChange={setSearchTerm}
        onFilterChange={setFilter}
        onSelectItem={setSelectedItem}
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
    <div className="mobile-detail-panel mobile-measurement-panel">
      <div className="mobile-panel-title-row">
        <h2>Aufmaßpakete</h2>
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
  onBack,
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
  onBack: () => void;
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

      {isItemsLoading ? <div className="empty-panel">Aufmaßpositionen werden geladen...</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
      {!isItemsLoading && !error && allItems.length === 0 ? (
        <div className="empty-panel">Noch keine Aufmaßpositionen importiert.</div>
      ) : null}
      {!isItemsLoading && !error && allItems.length > 0 && items.length === 0 ? (
        <div className="empty-panel">Keine Aufmaßposition gefunden.</div>
      ) : null}
      {!isItemsLoading && !error && items.length > 0 ? (
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
  return (
    <div className="mobile-detail-panel mobile-measurement-detail">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>{batch.title}</span>
      </button>

      <div className="mobile-measurement-detail-head">
        <span className={`measurement-status mobile-status-${item.mobile_status}`}>{mobileStatusLabel(item.mobile_status)}</span>
        <h2>{item.position}</h2>
        <p>{item.description}</p>
      </div>

      <div className="mobile-measurement-facts">
        <span>Einheit <strong>{item.unit ?? "-"}</strong></span>
        <span>Min/Einh. <strong>{formatMeasurementNumber(item.minutes_per_unit)}</strong></span>
        <span>Menge Liste <strong>{formatMeasurementNumber(item.list_quantity)}</strong></span>
        <span>Gemeldet <strong>{formatMeasurementNumber(item.reported_quantity)} {item.unit ?? ""}</strong></span>
        <span>Minuten <strong>{formatMeasurementNumber(item.reported_minutes)}</strong></span>
        <span>Stunden <strong>{formatMeasurementNumber(item.reported_hours)}</strong></span>
      </div>

      <div className="mobile-measurement-entries">
        <div className="mobile-panel-title-row">
          <h3>Aufmaßzeilen</h3>
        </div>

        {item.entries.length === 0 ? <p className="empty-inline">Noch keine Aufmaßzeilen erfasst.</p> : null}
        {item.entries.map((entry) => (
          <article className="mobile-measurement-entry" key={entry.id}>
            <strong>{entry.area_or_comment}</strong>
            <span>{formatMeasurementNumber(entry.quantity)} {item.unit ?? ""}</span>
            <small>{[entry.created_by_name, formatDateTime(entry.created_at)].filter(Boolean).join(" · ")}</small>
          </article>
        ))}
      </div>

      {isDraft ? (
        <div className="mobile-measurement-form">
          <h3>Aufmaßzeile hinzufügen</h3>
          <label>
            <span>Bereich / Kommentar</span>
            <textarea value={formComment} onChange={(event) => onCommentChange(event.target.value)} rows={3} />
          </label>
          <label>
            <span>Menge ({item.unit ?? "Einheit"})</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={formQuantity}
              onChange={(event) => onQuantityChange(event.target.value)}
            />
          </label>
          {formError ? <p className="form-error">{formError}</p> : null}
          <div className="mobile-form-actions">
            <button className="secondary-action" type="button" onClick={onCancelForm} disabled={isSaving}>Leeren</button>
            <button className="primary-action" type="button" onClick={onSave} disabled={isSaving}>{isSaving ? "Speichern..." : "Speichern"}</button>
          </div>
        </div>
      ) : (
        <p className="form-info">Dieses Aufmaß ist nicht mehr im Entwurf. Neue Aufmaßzeilen sind gesperrt.</p>
      )}
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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
