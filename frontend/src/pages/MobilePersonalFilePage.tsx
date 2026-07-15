import {
  ArrowLeft,
  AlertTriangle,
  CarFront,
  ChevronRight,
  HeartPulse,
  MoreVertical,
  Plane,
  RefreshCcw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { ToolMaterialCategoryIcon } from "../components/ToolMaterialCategoryIcon";
import { ApiError, api } from "../lib/api";
import type { MobilePersonalFile, MobilePersonalFileTool, MobileToolIssueReason } from "../types/mobile";


export function MobilePersonalFilePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MobilePersonalFile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadPersonalFile = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.myPersonalFile();
      if (requestId === requestIdRef.current) {
        setData(response);
      }
    } catch (requestError) {
      if (requestId === requestIdRef.current) {
        setError(readApiError(requestError, "Deine persönliche Akte konnte nicht geladen werden."));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useRefreshOnFocus(loadPersonalFile, requestIdRef);

  return (
    <section className="mobile-page mobile-personal-file-page">
      <MobilePersonalFileHeader
        subtitle={`Meine Übersicht · ${data?.current_year ?? new Date().getFullYear()}`}
        title="Persönliche Akte"
        onBack={() => navigate("/me/assignments")}
      />

      {isLoading && !data ? <MobilePersonalFileSkeleton /> : null}
      {error && !data ? (
        <MobilePersonalFileError message={error} onRetry={() => void loadPersonalFile()} />
      ) : null}

      {data ? (
        <div className="mobile-personal-file-content" aria-busy={isLoading}>
          {notice ? <p className="mobile-tool-report-success" role="status">{notice}</p> : null}
          {error ? <MobilePersonalFileInlineError message={error} onRetry={() => void loadPersonalFile()} /> : null}
          <div className="mobile-personal-stat-grid">
            <article className="mobile-personal-stat-card is-vacation">
              <span className="mobile-personal-icon-tile"><Plane aria-hidden="true" size={23} /></span>
              <span>Resturlaub</span>
              <strong>{formatDays(data.remaining_vacation_days)}</strong>
              <small>von {formatAvailableDays(data.total_vacation_days)}</small>
            </article>
            <article className="mobile-personal-stat-card is-sickness">
              <span className="mobile-personal-icon-tile"><HeartPulse aria-hidden="true" size={23} /></span>
              <span>Krankheitstage</span>
              <strong>{formatDays(data.sick_days)}</strong>
              <small>im Jahr {data.current_year}</small>
            </article>
          </div>

          <article className="mobile-personal-vehicle-card">
            <span className="mobile-personal-icon-tile"><CarFront aria-hidden="true" size={25} /></span>
            <div>
              <span>Fahrzeug</span>
              <strong>{data.vehicle?.name ?? "Kein Fahrzeug zugeordnet"}</strong>
              {data.vehicle ? (
                <small>{formatVehicleDetails(data.vehicle.fleet_number, data.vehicle.vehicle_registration)}</small>
              ) : null}
            </div>
            {data.vehicle ? <span className="mobile-personal-assigned-badge">Zugeordnet</span> : null}
          </article>

          <article className="mobile-personal-tools-card">
            <header>
              <span className="mobile-personal-icon-tile"><Wrench aria-hidden="true" size={24} /></span>
              <h2>Werkzeuge / Material</h2>
              <span className="mobile-personal-tool-count">{data.tool_count} zugeordnet</span>
            </header>
            {data.tool_preview.length ? (
              <div className="mobile-personal-tool-preview-list">
                {data.tool_preview.map((tool, index) => (
                  <MobilePersonalToolRow
                    key={toolKey(tool, index)}
                    tool={tool}
                    onAssignmentConflict={() => void loadPersonalFile()}
                    onReported={setNotice}
                  />
                ))}
              </div>
            ) : (
              <p className="mobile-personal-tools-empty">
                Dir sind aktuell keine Werkzeuge oder Materialien zugeordnet.
              </p>
            )}
            {data.tool_count > 3 ? (
              <button
                className="mobile-personal-show-all"
                type="button"
                onClick={() => navigate("/me/personal-file/tools")}
              >
                <span>Alle {data.tool_count} anzeigen</span>
                <ChevronRight aria-hidden="true" size={18} />
              </button>
            ) : null}
          </article>
        </div>
      ) : null}
    </section>
  );
}


export function MobilePersonalFileToolsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<MobilePersonalFileTool[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadTools = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.myPersonalFileTools();
      if (requestId === requestIdRef.current) {
        setItems(response);
      }
    } catch (requestError) {
      if (requestId === requestIdRef.current) {
        setError(readApiError(requestError, "Werkzeuge und Material konnten nicht geladen werden."));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useRefreshOnFocus(loadTools, requestIdRef);

  return (
    <section className="mobile-page mobile-personal-file-page mobile-personal-tools-page">
      <MobilePersonalFileHeader
        subtitle="Aktuell zugeordnet"
        title="Werkzeuge / Material"
        onBack={() => navigate("/me/personal-file")}
      />
      {isLoading && !items.length ? <MobilePersonalToolsSkeleton /> : null}
      {error && !items.length ? (
        <MobilePersonalFileError message={error} onRetry={() => void loadTools()} />
      ) : null}
      {items.length ? (
        <div className="mobile-personal-tool-full-list" aria-busy={isLoading}>
          {notice ? <p className="mobile-tool-report-success" role="status">{notice}</p> : null}
          {error ? <MobilePersonalFileInlineError message={error} onRetry={() => void loadTools()} /> : null}
          {items.map((tool, index) => (
            <MobilePersonalToolRow
              detailed
              key={toolKey(tool, index)}
              tool={tool}
              onAssignmentConflict={() => void loadTools()}
              onReported={setNotice}
            />
          ))}
        </div>
      ) : null}
      {!isLoading && !error && !items.length ? (
        <p className="mobile-personal-tools-empty is-standalone">
          Dir sind aktuell keine Werkzeuge oder Materialien zugeordnet.
        </p>
      ) : null}
    </section>
  );
}


function MobilePersonalFileHeader({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
}) {
  return (
    <header className="mobile-personal-file-header">
      <button aria-label="Zurück" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={25} />
      </button>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}


function MobilePersonalToolRow({
  tool,
  detailed = false,
  onAssignmentConflict,
  onReported,
}: {
  tool: MobilePersonalFileTool;
  detailed?: boolean;
  onAssignmentConflict: () => void;
  onReported: (message: string) => void;
}) {
  return (
    <div className={`mobile-personal-tool-row${detailed ? " is-detailed" : ""}`}>
      <span className="mobile-personal-tool-icon">
        <ToolMaterialCategoryIcon category={tool.category} size={23} />
      </span>
      <div>
        <strong>{formatToolTitle(tool)}</strong>
        <small>{formatBegNumber(tool.beg_number)}</small>
        {detailed && tool.item_date ? <small>Ausgegeben am {formatGermanDate(tool.item_date)}</small> : null}
      </div>
      <MobileToolIssueAction
        tool={tool}
        onAssignmentConflict={onAssignmentConflict}
        onReported={onReported}
      />
    </div>
  );
}


function MobileToolIssueAction({
  tool,
  onAssignmentConflict,
  onReported,
}: {
  tool: MobilePersonalFileTool;
  onAssignmentConflict: () => void;
  onReported: (message: string) => void;
}) {
  const [stage, setStage] = useState<"closed" | "menu" | "confirm">("closed");
  const [reason, setReason] = useState<MobileToolIssueReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stage === "closed") return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setStage("closed");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saving, stage]);

  function chooseReason(nextReason: MobileToolIssueReason) {
    setReason(nextReason);
    setError(null);
    setStage("confirm");
  }

  async function submit() {
    if (!reason || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.reportMyPersonalFileTool(tool.id, reason, crypto.randomUUID());
      onReported(response.message);
      setStage("closed");
    } catch (requestError) {
      setError(readApiError(requestError, "Werkzeugmeldung konnte nicht gesendet werden."));
      if (requestError instanceof ApiError && requestError.status === 409) {
        onAssignmentConflict();
      }
    } finally {
      setSaving(false);
    }
  }

  const reasonLabel = reason === "DEFECTIVE" ? "Maschine defekt" : "Maschine entwendet";
  return (
    <>
      <button
        aria-label="Problem mit diesem Werkzeug melden"
        className="mobile-tool-issue-trigger"
        type="button"
        onClick={() => { setError(null); setStage("menu"); }}
      >
        <MoreVertical aria-hidden="true" size={21} />
      </button>
      {stage !== "closed" ? createPortal(
        <div className="mobile-dialog-backdrop mobile-tool-issue-backdrop" role="presentation" onClick={() => !saving && setStage("closed")}>
          <section
            aria-label={stage === "menu" ? "Werkzeugproblem auswählen" : reasonLabel}
            aria-modal="true"
            className="mobile-tool-issue-sheet"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            {stage === "menu" ? (
              <>
                <strong>Problem melden</strong>
                <button type="button" onClick={() => chooseReason("DEFECTIVE")}>
                  <AlertTriangle aria-hidden="true" size={20} /><span>Maschine defekt</span>
                </button>
                <button type="button" onClick={() => chooseReason("STOLEN")}>
                  <ShieldAlert aria-hidden="true" size={20} /><span>Maschine entwendet</span>
                </button>
              </>
            ) : (
              <>
                <h2>{reason === "DEFECTIVE" ? "Maschine defekt melden?" : "Maschine als entwendet melden?"}</h2>
                <strong>{formatToolTitle(tool)}</strong>
                <span>{formatBegNumber(tool.beg_number)}</span>
                <p>Der Werkzeug-Beauftragte wird informiert.</p>
                {error ? <p className="mobile-tool-issue-error" role="alert">{error}</p> : null}
                <div className="mobile-tool-issue-actions">
                  <button disabled={saving} type="button" onClick={() => setStage("closed")}>Abbrechen</button>
                  <button className="is-primary" disabled={saving} type="button" onClick={() => void submit()}>
                    {saving ? "Wird gesendet…" : "Meldung senden"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}


function MobilePersonalFileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mobile-personal-file-error" role="alert">
      <p>{message}</p>
      <button className="icon-button secondary" type="button" onClick={onRetry}>
        <RefreshCcw aria-hidden="true" size={16} />
        <span>Erneut versuchen</span>
      </button>
    </div>
  );
}


function MobilePersonalFileInlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mobile-personal-inline-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>Wiederholen</button>
    </div>
  );
}


function MobilePersonalFileSkeleton() {
  return (
    <div className="mobile-personal-file-skeleton" aria-label="Persönliche Akte wird geladen">
      <div className="mobile-personal-stat-grid"><span /><span /></div>
      <span className="is-vehicle" />
      <span className="is-tools" />
    </div>
  );
}


function MobilePersonalToolsSkeleton() {
  return (
    <div className="mobile-personal-tools-skeleton" aria-label="Werkzeuge werden geladen">
      <span /><span /><span />
    </div>
  );
}


function useRefreshOnFocus(
  load: () => Promise<void>,
  requestIdRef: MutableRefObject<number>,
) {
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void load();
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, requestIdRef]);
}


function formatDays(value: number): string {
  return `${value} ${value === 1 ? "Tag" : "Tage"}`;
}


function formatAvailableDays(value: number): string {
  return `${value} ${value === 1 ? "Tag" : "Tagen"}`;
}


function formatVehicleDetails(fleetNumber: string | null, registration: string | null): string {
  return [fleetNumber ? `BEG ${fleetNumber}` : null, registration].filter(Boolean).join(" · ");
}


function formatToolTitle(tool: MobilePersonalFileTool): string {
  return [tool.manufacturer, tool.designation].filter(Boolean).join(" ");
}


function formatBegNumber(value: string | null): string {
  if (!value) {
    return "Keine BEG-Nr.";
  }
  return /^BEG(?:\s|-)/i.test(value) ? value : `BEG ${value}`;
}


function formatGermanDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}


function toolKey(tool: MobilePersonalFileTool, index: number): string {
  return String(tool.id || index);
}


function readApiError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
