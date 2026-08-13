import {
  ArrowLeft,
  AlertTriangle,
  CarFront,
  ChevronRight,
  Clock,
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
import { useMobileScrollReset } from "../lib/mobileScroll";
import type {
  MobilePersonalFile,
  MobilePersonalFileAbsenceResponse,
  MobilePersonalFileAbsenceType,
  MobilePersonalFileTool,
  MobileToolIssueReason,
} from "../types/mobile";


export function MobilePersonalFilePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MobilePersonalFile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useMobileScrollReset("personal-file");

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
            <button
              aria-label="Urlaubsdetails öffnen"
              className="mobile-personal-stat-card is-vacation is-action"
              type="button"
              onClick={() => navigate("/me/personal-file/vacation")}
            >
              <span className="mobile-personal-icon-tile"><Plane aria-hidden="true" size={23} /></span>
              <span>Resturlaub</span>
              <strong>{formatDays(data.remaining_vacation_days)}</strong>
              <small>von {formatAvailableDays(data.total_vacation_days)}</small>
              <ChevronRight aria-hidden="true" className="mobile-personal-stat-chevron" size={18} />
            </button>
            <button
              aria-label="Krankheitsdetails öffnen"
              className="mobile-personal-stat-card is-sickness is-action"
              type="button"
              onClick={() => navigate("/me/personal-file/sickness")}
            >
              <span className="mobile-personal-icon-tile"><HeartPulse aria-hidden="true" size={23} /></span>
              <span>Krankheitstage</span>
              <strong>{formatDays(data.sick_days)}</strong>
              <small>im Jahr {data.current_year}</small>
              <ChevronRight aria-hidden="true" className="mobile-personal-stat-chevron" size={18} />
            </button>
          </div>

          <article className={`mobile-personal-hours-card ${hoursAccountTone(data.hours_account.current_balance_minutes)}`}>
            <span className="mobile-personal-icon-tile"><Clock aria-hidden="true" size={25} /></span>
            <div>
              <span>Überstundenkonto</span>
              <strong>{formatOvertimeHours(data.hours_account.current_balance_minutes)}</strong>
              <small>{formatHoursAccountStand(data.hours_account.last_entry_at)}</small>
            </div>
            <span className="mobile-personal-hours-badge">
              {hoursAccountStatusLabel(data.hours_account.current_balance_minutes)}
            </span>
          </article>

          <article className="mobile-personal-vehicle-card">
            <span className="mobile-personal-icon-tile"><CarFront aria-hidden="true" size={25} /></span>
            <div>
              <span>Fahrzeug</span>
              <strong>{data.vehicle?.license_plate ?? "Kein Fahrzeug zugeordnet"}</strong>
              {data.vehicle ? (
                <small>{data.vehicle.manufacturer}</small>
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
                    onReported={(message) => {
                      setNotice(message);
                      void loadPersonalFile();
                    }}
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


export function MobilePersonalFileAbsencePage({
  absenceType,
}: {
  absenceType: MobilePersonalFileAbsenceType;
}) {
  const navigate = useNavigate();
  const year = new Date().getFullYear();
  const [data, setData] = useState<MobilePersonalFileAbsenceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isVacation = absenceType === "vacation";

  useMobileScrollReset(`personal-file-${absenceType}`);

  const loadAbsences = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.myPersonalFileAbsences({ absenceType, year });
      if (requestId === requestIdRef.current) {
        setData(response);
      }
    } catch (requestError) {
      if (requestId === requestIdRef.current) {
        setError(readApiError(
          requestError,
          isVacation
            ? "Deine Urlaubstage konnten nicht geladen werden."
            : "Deine Krankheitstage konnten nicht geladen werden.",
        ));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [absenceType, isVacation, year]);

  useRefreshOnFocus(loadAbsences, requestIdRef);

  return (
    <section className="mobile-page mobile-personal-file-page mobile-personal-absence-page">
      <MobilePersonalFileHeader
        subtitle={`${isVacation ? "Meine Urlaubstage" : "Meine Krankheitstage"} · ${data?.year ?? year}`}
        title={isVacation ? "Urlaub" : "Krankheit"}
        onBack={() => navigate("/me/personal-file")}
      />

      {isLoading && !data ? <MobilePersonalAbsenceSkeleton /> : null}
      {error && !data ? (
        <MobilePersonalFileError message={error} onRetry={() => void loadAbsences()} />
      ) : null}

      {data ? (
        <div className="mobile-personal-absence-content" aria-busy={isLoading}>
          {error ? <MobilePersonalFileInlineError message={error} onRetry={() => void loadAbsences()} /> : null}
          {isVacation ? (
            <section className="mobile-personal-absence-summary is-vacation" aria-label={`Urlaubsübersicht ${data.year}`}>
              <div className="is-primary">
                <span>Resturlaub</span>
                <strong>{formatDays(data.remaining_vacation_days)}</strong>
              </div>
              <div>
                <span>Jahresurlaub</span>
                <strong>{formatDays(data.total_vacation_days)}</strong>
              </div>
              <div>
                <span>Genommener Urlaub</span>
                <strong>{formatDays(data.taken_vacation_days)}</strong>
              </div>
            </section>
          ) : (
            <section className="mobile-personal-absence-summary is-sickness" aria-label={`Krankheitsübersicht ${data.year}`}>
              <div className="is-primary">
                <span>Krankheitstage</span>
                <strong>{formatDays(data.sick_days)}</strong>
                <small>im Jahr {data.year}</small>
              </div>
            </section>
          )}

          {data.weeks.length ? (
            <div className="mobile-personal-absence-weeks">
              {data.weeks.map((week) => (
                <section className="mobile-personal-absence-week" key={`${week.iso_year}-${week.iso_week}`}>
                  <header>
                    <strong>KW {week.iso_week}</strong>
                    <span>{formatCompactDateRange(week.week_start, week.week_end)}</span>
                  </header>
                  <div>
                    {week.entries.map((entry) => (
                      <article
                        className={`mobile-personal-absence-entry is-${entry.absence_type}`}
                        key={`${entry.source_id}-${week.iso_year}-${week.iso_week}`}
                      >
                        <span>{entry.absence_type === "vacation" ? "Urlaub" : "Krank"}</span>
                        <strong>{formatMobileAbsenceDateRange(entry.start_date, entry.end_date)}</strong>
                        <small>{formatDays(entry.day_count)}</small>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className={`mobile-personal-absence-empty is-${absenceType}`}>
              <strong>Keine {isVacation ? "Urlaubstage" : "Krankheitstage"} in {data.year}</strong>
              <p>Für dieses Jahr sind keine {isVacation ? "Urlaubstage" : "Krankheitstage"} hinterlegt.</p>
            </div>
          )}
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

  useMobileScrollReset("personal-file-tools");

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
              onReported={(message) => {
                setNotice(message);
                void loadTools();
              }}
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
  const [stage, setStage] = useState<"closed" | "menu" | "confirm" | "details">("closed");
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
  const hasOpenIssue = tool.open_issue_reports.length > 0;
  return (
    <>
      <button
        aria-label={hasOpenIssue ? "Offene Werkzeugmeldung anzeigen" : "Problem mit diesem Werkzeug melden"}
        className={`mobile-tool-issue-trigger${hasOpenIssue ? " has-open-issue" : ""}`}
        type="button"
        onClick={() => { setError(null); setStage(hasOpenIssue ? "details" : "menu"); }}
      >
        {hasOpenIssue
          ? <AlertTriangle aria-hidden="true" size={21} />
          : <MoreVertical aria-hidden="true" size={21} />}
      </button>
      {stage !== "closed" ? createPortal(
        <div className="mobile-dialog-backdrop mobile-tool-issue-backdrop" role="presentation" onClick={() => !saving && setStage("closed")}>
          <section
            aria-label={stage === "menu"
              ? "Werkzeugproblem auswählen"
              : stage === "details" ? "Offene Werkzeugmeldungen" : reasonLabel}
            aria-modal="true"
            className="mobile-tool-issue-sheet"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            {stage === "details" ? (
              <>
                <div className="mobile-tool-issue-detail-heading">
                  <span className="mobile-personal-tool-icon" aria-hidden="true">
                    <AlertTriangle size={21} />
                  </span>
                  <div>
                    <h2>Offene Meldungen</h2>
                    <strong>{formatToolTitle(tool)}</strong>
                    <span>Gerätenummer: {tool.device_number || "Nicht hinterlegt"}</span>
                  </div>
                </div>
                <div className="mobile-tool-issue-detail-list">
                  {tool.open_issue_reports.map((report) => (
                    <article key={report.id}>
                      <div>
                        <strong>{formatToolIssueReason(report.reason)}</strong>
                        <span className="mobile-tool-issue-status">{formatToolIssueStatus(report.status)}</span>
                      </div>
                      <p>{report.description}</p>
                      <time dateTime={report.created_at}>{formatToolIssueDateTime(report.created_at)}</time>
                    </article>
                  ))}
                </div>
                <div className="mobile-tool-issue-actions">
                  <button className="is-primary" type="button" onClick={() => setStage("closed")}>Schließen</button>
                </div>
              </>
            ) : stage === "menu" ? (
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
      <span className="is-hours" />
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


function MobilePersonalAbsenceSkeleton() {
  return (
    <div className="mobile-personal-absence-skeleton" aria-label="Fehlzeiten werden geladen">
      <span className="is-summary" />
      <span />
      <span />
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


function formatOvertimeHours(minutes: number): string {
  const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
  const hours = Math.abs(minutes) / 60;
  return `${sign}${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hours)} Std.`;
}


function formatHoursAccountStand(value: string | null): string {
  if (!value) {
    return "Noch keine Buchungen";
  }
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return `Stand: ${value}`;
  }
  return `Stand: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(parsedDate)}`;
}


function hoursAccountTone(minutes: number): string {
  if (minutes > 0) return "is-positive";
  if (minutes < 0) return "is-negative";
  return "is-neutral";
}


function hoursAccountStatusLabel(minutes: number): string {
  if (minutes > 0) return "Guthaben";
  if (minutes < 0) return "Minusstunden";
  return "Ausgeglichen";
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


function formatMobileAbsenceDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatGermanDate(startDate);
  }
  return `${formatGermanDate(startDate)} – ${formatGermanDate(endDate)}`;
}


function formatCompactDateRange(startDate: string, endDate: string): string {
  const [startYear, startMonth, startDay] = startDate.split("-");
  const [endYear, endMonth, endDay] = endDate.split("-");
  if (!startYear || !startMonth || !startDay || !endYear || !endMonth || !endDay) {
    return formatMobileAbsenceDateRange(startDate, endDate);
  }
  if (startYear === endYear) {
    return `${startDay}.${startMonth}. – ${endDay}.${endMonth}.${endYear}`;
  }
  return `${startDay}.${startMonth}.${startYear} – ${endDay}.${endMonth}.${endYear}`;
}


function formatToolIssueReason(reason: MobileToolIssueReason): string {
  return reason === "DEFECTIVE" ? "Maschine defekt" : "Maschine entwendet";
}


function formatToolIssueStatus(status: string): string {
  if (status === "in_progress") return "In Bearbeitung";
  if (status === "resolved" || status === "completed") return "Erledigt";
  return "Gemeldet";
}


function formatToolIssueDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}


function toolKey(tool: MobilePersonalFileTool, index: number): string {
  return String(tool.id || index);
}


function readApiError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
