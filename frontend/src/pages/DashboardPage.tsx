import { AlertTriangle, BriefcaseBusiness, CalendarClock, CloudSun, Inbox } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { api, type DashboardOverview, type DashboardOverviewPerson } from "../lib/api";
import type { MatrixPerson, MatrixResponse, MatrixRow, MatrixSite } from "../types/matrix";
import type { Person } from "../types/person";
import type { MeasurementDashboardSubmission } from "../types/site";
import type { WeatherSummary } from "../types/weather";

type DateRange = {
  historyStart: string;
  today: string;
  tomorrow: string;
  weekStart: string;
  weekEnd: string;
  nextWeekStart: string;
  nextWeekEnd: string;
};

type ManagerSummary = {
  key: string;
  label: string;
  name: string;
};

type AssignedSiteSummary = {
  site: MatrixSite;
  managerLabel: string;
  internalCount: number;
  externalCount: number;
  hasWarnings: boolean;
};

type AssignedSiteGroup = {
  manager: ManagerSummary;
  sites: AssignedSiteSummary[];
};

type FreeWorkerGroup = {
  manager: ManagerSummary;
  people: Person[];
};

type WorkerSummaryGroup = {
  kind: "assigned" | "free";
  manager: ManagerSummary;
  people: DashboardOverviewPerson[];
};

type StaffingNeed = {
  date: string;
  siteName: string;
  siteNumber: string | null;
  managerLabel: string;
};

type DashboardConflict = {
  key: string;
  title: string;
  detail: string;
  severity: "hard" | "warning";
  date: string;
};

type DashboardData = {
  todayAssignedSites: AssignedSiteSummary[];
  todayAssignedSiteGroups: AssignedSiteGroup[];
  workerSummaryGroups: WorkerSummaryGroup[];
  totalWorkerSummaryPeople: number;
  freeWorkerGroups: FreeWorkerGroup[];
  totalFreeWorkers: number;
  openStaffingNeeds: StaffingNeed[];
  conflicts: DashboardConflict[];
  tomorrowAssignedCount: number;
  tomorrowOpenNeeds: StaffingNeed[];
  tomorrowConflicts: DashboardConflict[];
  currentWeekNeeds: StaffingNeed[];
  nextWeekNeeds: StaffingNeed[];
};

const MAX_PREVIEW_ITEMS = 6;
const DASHBOARD_MESSAGES_UPDATED_EVENT = "dashboard-messages-updated";
const FREE_WORKER_ALL_KEY = "__all__";

export function DashboardPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [measurementMessages, setMeasurementMessages] = useState<MeasurementDashboardSubmission[]>([]);
  const [dashboardOverview, setDashboardOverview] = useState<DashboardOverview | null>(null);
  const [dismissingMessageKey, setDismissingMessageKey] = useState<string | null>(null);
  const [openFreeWorkerKey, setOpenFreeWorkerKey] = useState<string | null>(null);
  const freeSummaryRef = useRef<HTMLDivElement | null>(null);

  const range = useMemo(() => getDashboardRange(new Date()), []);

  useEffect(() => {
    let active = true;

    if (user?.role === "monteur") {
      setLoading(false);
      return undefined;
    }

    async function loadDashboard() {
      setLoading(true);
      setError(null);
      try {
        const [overviewData, measurementData] = await Promise.all([
          api.dashboardOverview({
            historyStart: range.historyStart,
            today: range.today,
            tomorrow: range.tomorrow,
            weekEnd: range.weekEnd,
            nextWeekStart: range.nextWeekStart,
            nextWeekEnd: range.nextWeekEnd,
          }),
          api.dashboardMessagesSummary().then((summary) => summary.latest_messages).catch(() => [] as MeasurementDashboardSubmission[]),
        ]);
        if (!active) {
          return;
        }
        setDashboardOverview(overviewData);
        setMeasurementMessages(measurementData);
      } catch {
        if (!active) {
          return;
        }
        setError("Dashboarddaten konnten nicht geladen werden.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadDashboard();

    return () => {
      active = false;
    };
  }, [
    range.historyStart,
    range.nextWeekEnd,
    range.nextWeekStart,
    range.today,
    range.tomorrow,
    range.weekEnd,
    user?.role,
  ]);

  useEffect(() => {
    function handleDashboardMessagesUpdated(event: Event) {
      const messages = (event as CustomEvent<MeasurementDashboardSubmission[]>).detail;
      if (Array.isArray(messages)) {
        setMeasurementMessages((current) => (
          dashboardMessagesSignature(current) === dashboardMessagesSignature(messages)
            ? current
            : messages
        ));
      }
    }

    window.addEventListener(DASHBOARD_MESSAGES_UPDATED_EVENT, handleDashboardMessagesUpdated);

    return () => {
      window.removeEventListener(DASHBOARD_MESSAGES_UPDATED_EVENT, handleDashboardMessagesUpdated);
    };
  }, []);

  useEffect(() => {
    if (!openFreeWorkerKey) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (!freeSummaryRef.current?.contains(event.target as Node)) {
        setOpenFreeWorkerKey(null);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpenFreeWorkerKey(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openFreeWorkerKey]);

  useEffect(() => {
    let active = true;

    if (user?.role === "monteur") {
      return undefined;
    }

    async function loadWeather() {
      setWeatherLoading(true);
      try {
        const weatherData = await api.dashboardWeather();
        if (active) {
          setWeather(weatherData);
        }
      } catch {
        if (active) {
          setWeather(null);
        }
      } finally {
        if (active) {
          setWeatherLoading(false);
        }
      }
    }

    void loadWeather();

    return () => {
      active = false;
    };
  }, [user?.role]);

  const dashboard = dashboardOverview;
  const workerSummaryGroups = dashboard?.workerSummaryGroups ?? [];
  const workerSummaryCount = dashboard?.totalWorkerSummaryPeople ?? 0;
  const allSummaryWorkers = workerSummaryGroups.flatMap((group) => (
    group.people.map((person) => ({
      ...person,
      detail: formatWorkerSummaryGroupDetail(person, group),
    }))
  ));

  function toggleFreeWorkerPopover(key: string): void {
    setOpenFreeWorkerKey((current) => current === key ? null : key);
  }

  async function dismissMeasurementMessage(message: MeasurementDashboardSubmission): Promise<void> {
    if (dismissingMessageKey) {
      return;
    }
    const previousMessages = measurementMessages;
    setDismissingMessageKey(message.message_key);
    setMeasurementMessages((current) => current.filter((entry) => entry.message_key !== message.message_key));
    try {
      await api.dismissDashboardMessage(message.message_key);
    } catch {
      setMeasurementMessages(previousMessages);
    } finally {
      setDismissingMessageKey(null);
    }
  }

  if (user?.role === "monteur") {
    return (
      <section className="dashboard-page page-stack">
        <div className="dashboard-hero dashboard-hero-simple">
          <div>
            <p className="eyebrow">Ubersicht</p>
            <h1>{formatFullDate(range.today)}</h1>
            <p>Fuer Monteure bleibt die mobile Ansicht der direkte Einstieg in die eigenen Einsaetze.</p>
          </div>
          <Link className="dashboard-primary-link" to="/me/assignments">Meine Einsaetze anzeigen</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-page page-stack">
      <header className="dashboard-hero">
        <div className="dashboard-hero-main">
          <p className="eyebrow">Tagesstart</p>
          <h1>{formatFullDate(range.today)}</h1>
          <p>Heute, morgen und die nächsten beiden Wochen auf einen Blick.</p>
        </div>
        <div className="dashboard-weather" aria-label="Wetter Firmenzentrale">
          <span className="dashboard-panel-label">Wetter Firmenzentrale</span>
          <div className="dashboard-weather-main">
            <CloudSun aria-hidden="true" size={24} />
            <strong>{formatDashboardWeatherTemperature(weather, weatherLoading)}</strong>
            <span>{formatDashboardWeatherCondition(weather, weatherLoading)}</span>
          </div>
          <p>{formatDashboardWeatherMeta(weather)}</p>
        </div>
        <div className="dashboard-free-summary" ref={freeSummaryRef}>
          <div className="dashboard-free-total">
            <button
              aria-expanded={openFreeWorkerKey === FREE_WORKER_ALL_KEY}
              className={`dashboard-free-total-button${openFreeWorkerKey === FREE_WORKER_ALL_KEY ? " is-active" : ""}`}
              disabled={!dashboard}
              type="button"
              onClick={() => toggleFreeWorkerPopover(FREE_WORKER_ALL_KEY)}
            >
              <span className="dashboard-free-summary-label">Einsatz heute</span>
              <strong>{dashboard ? workerSummaryCount : loading ? "..." : "-"}</strong>
              <small>Monteure</small>
            </button>
            {dashboard && openFreeWorkerKey === FREE_WORKER_ALL_KEY ? (
              <FreeWorkerPopover
                title="Monteure heute - Alle"
                people={allSummaryWorkers}
              />
            ) : null}
          </div>
          {dashboard ? (
            <>
              <div className="dashboard-pill-row">
                {workerSummaryGroups.length > 0 ? workerSummaryGroups.map((group) => (
                  <span className="dashboard-pill-shell" key={group.manager.key}>
                    <button
                      aria-expanded={openFreeWorkerKey === group.manager.key}
                      className={`dashboard-pill${openFreeWorkerKey === group.manager.key ? " is-active" : ""}`}
                      title={group.people.map((person) => person.display_name).join(", ")}
                      type="button"
                      onClick={() => toggleFreeWorkerPopover(group.manager.key)}
                    >
                      <span>{formatWorkerSummaryBadgeLabel(group)}</span>
                      <strong>{group.people.length}</strong>
                    </button>
                    {openFreeWorkerKey === group.manager.key ? (
                      <FreeWorkerPopover
                        title={formatWorkerSummaryPopoverTitle(group)}
                        people={group.people}
                      />
                    ) : null}
                  </span>
                )) : <span className="dashboard-muted">Keine Monteure erkannt</span>}
              </div>
            </>
          ) : null}
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="empty-panel"><p>Dashboard wird geladen...</p></div>}

      {dashboard && !loading && (
        <>
          <div className="dashboard-main-grid">
            <DashboardCard
              title="Heute besetzte Baustellen"
              icon={<BriefcaseBusiness aria-hidden="true" size={20} />}
              meta={formatTodayAssignedMeta(dashboard.todayAssignedSites)}
              className="dashboard-card-large"
            >
              {dashboard.todayAssignedSites.length > 0 ? (
                <div className="dashboard-site-group-list">
                  {dashboard.todayAssignedSiteGroups.map((group) => (
                    <section className="dashboard-site-group" key={group.manager.key}>
                      <div className="dashboard-site-group-header">
                        <strong>{formatDashboardManagerHeading(group.manager)}</strong>
                        <span>{formatAssignedSiteGroupMeta(group.sites)}</span>
                      </div>
                      <div className="dashboard-site-tile-grid">
                        {group.sites.map((siteSummary) => (
                          <Link className="dashboard-site-tile" to={"/sites/" + siteSummary.site.id} key={siteSummary.site.id} title={siteSummary.site.name}>
                            <span className="dashboard-site-tile-name">{siteSummary.site.name}</span>
                            <span className="dashboard-site-tile-count">{formatSiteTileMeta(siteSummary)}</span>
                            {siteSummary.hasWarnings && <span className="dashboard-signal signal-orange">Pruefen</span>}
                          </Link>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : <EmptyDashboardText text="Heute sind keine Baustellen besetzt." />}
            </DashboardCard>

            <DashboardCard
              title="Eingang / Meldungen"
              icon={<Inbox aria-hidden="true" size={20} />}
              badge={measurementMessages.length > 0 ? String(measurementMessages.length) : undefined}
            >
              {measurementMessages.length > 0 ? (
                <div className="dashboard-alert-list">
                  {measurementMessages.map((message) => (
                    <div className="dashboard-alert-row dashboard-message-row" key={message.message_key}>
                      <Link
                        className="dashboard-message-link"
                        to={getDashboardMessageLink(message)}
                      >
                        <span className="dashboard-alert-dot signal-blue" aria-hidden="true" />
                        <div>
                          <strong>{formatMeasurementDashboardMessageTitle(message)}</strong>
                          <span>{formatMeasurementDashboardMessageMeta(message)}</span>
                        </div>
                      </Link>
                      <button
                        type="button"
                        className="dashboard-message-read-button"
                        aria-label="Meldung als gelesen markieren"
                        disabled={dismissingMessageKey === message.message_key}
                        onClick={() => void dismissMeasurementMessage(message)}
                      >
                        Als gelesen markieren
                      </button>
                    </div>
                  ))}
                  <p className="dashboard-message-unread-note">
                    {measurementMessages.length} ungelesene {measurementMessages.length === 1 ? "Meldung" : "Meldungen"} — bitte prüfen.
                  </p>
                </div>
              ) : (
                <div className="dashboard-message-box">
                  <strong>Keine neuen Meldungen</strong>
                  <p>Basisversion. Vorgesehen sind spaeter Monteurmeldungen, Bestellungen, Aufmasse und Rueckfragen.</p>
                </div>
              )}
            </DashboardCard>
          </div>

          <div className="dashboard-main-grid">
            <DashboardCard title="Pruefen / Konflikte" icon={<AlertTriangle aria-hidden="true" size={20} />}>
              <DashboardConflictList conflicts={dashboard.conflicts} needs={dashboard.openStaffingNeeds} />
            </DashboardCard>

            <DashboardCard title="Morgen / Woche vorbereiten" icon={<CalendarClock aria-hidden="true" size={20} />}>
              <div className="dashboard-prep-summary">
                <div>
                  <span>Morgen</span>
                  <strong>{dashboard.tomorrowAssignedCount}</strong>
                  <small>Baustellen besetzt</small>
                </div>
                <div>
                  <span>Personalbedarf</span>
                  <strong>{dashboard.tomorrowOpenNeeds.length}</strong>
                  <small>morgen offen</small>
                </div>
                <div>
                  <span>Konflikte</span>
                  <strong>{dashboard.tomorrowConflicts.length}</strong>
                  <small>morgen erkannt</small>
                </div>
              </div>
              <DashboardNeedSection title="Diese Woche" needs={dashboard.currentWeekNeeds} />
              <DashboardNeedSection title="Folgewoche" needs={dashboard.nextWeekNeeds} />
            </DashboardCard>
          </div>
        </>
      )}
    </section>
  );
}

function FreeWorkerPopover({
  title,
  people,
}: {
  title: string;
  people: DashboardOverviewPerson[];
}) {
  return (
    <div className="dashboard-free-popover" role="dialog" aria-label={title}>
      <div className="dashboard-free-popover-header">
        <strong>{title}</strong>
        <span>{people.length}</span>
      </div>
      {people.length > 0 ? (
        <div className="dashboard-free-person-list">
          {people.map((person, index) => (
            <div className="dashboard-free-person-row" key={`${person.id}:${person.detail ?? ""}:${index}`}>
              <strong>{person.display_name}</strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="dashboard-free-empty">Keine Personen</p>
      )}
    </div>
  );
}

function DashboardCard({
  title,
  icon,
  children,
  className,
  meta,
  badge,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  meta?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <article className={["dashboard-card", className ?? ""].filter(Boolean).join(" ")}>
      <div className="dashboard-card-header">
        <span>{icon}</span>
        <div>
          <h2>{title}</h2>
          {meta ? <p>{meta}</p> : null}
        </div>
        {badge ? <strong className="dashboard-card-badge">{badge}</strong> : null}
      </div>
      {children}
    </article>
  );
}

function DashboardConflictList({ conflicts, needs }: { conflicts: DashboardConflict[]; needs: StaffingNeed[] }) {
  const visibleConflicts = conflicts.slice(0, MAX_PREVIEW_ITEMS);
  const visibleNeeds = needs.slice(0, MAX_PREVIEW_ITEMS);

  if (visibleConflicts.length === 0 && visibleNeeds.length === 0) {
    return <EmptyDashboardText text="Keine harten Konflikte oder offenen Personalbedarfe im nahen Zeitraum erkannt." />;
  }

  return (
    <div className="dashboard-alert-list">
      {visibleConflicts.map((conflict) => (
        <div className="dashboard-alert-row" key={conflict.key}>
          <span className="dashboard-alert-dot signal-red" aria-hidden="true" />
          <div>
            <strong>{conflict.title}</strong>
            <span>{formatShortDate(conflict.date)} · {conflict.detail}</span>
          </div>
        </div>
      ))}
      {visibleNeeds.map((need) => (
        <div className="dashboard-alert-row" key={need.date + need.siteName + need.siteNumber}>
          <span className="dashboard-alert-dot signal-orange" aria-hidden="true" />
          <div>
            <strong>{formatShortDate(need.date)}: {need.siteName}</strong>
            <span>{need.managerLabel} · orange markiert, noch unbesetzt</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardNeedSection({ title, needs }: { title: string; needs: StaffingNeed[] }) {
  return (
    <div className="dashboard-need-section">
      <h3>{title}</h3>
      {needs.length > 0 ? (
        <ul>
          {needs.slice(0, 4).map((need) => (
            <li key={title + need.date + need.siteName + need.siteNumber}>
              <span className="dashboard-alert-dot signal-orange" aria-hidden="true" />
              {formatShortDate(need.date)} · {need.siteName} unbesetzt
            </li>
          ))}
        </ul>
      ) : <p>Keine offenen Personalbedarfe.</p>}
    </div>
  );
}

function EmptyDashboardText({ text }: { text: string }) {
  return <p className="dashboard-empty-text">{text}</p>;
}

function formatDashboardWeatherTemperature(weather: WeatherSummary | null, isLoading: boolean): string {
  if (isLoading) {
    return "...";
  }
  if (!weather?.available || weather.temperature === null) {
    return "-";
  }
  return `${Math.round(weather.temperature)}°C`;
}

function formatDashboardWeatherCondition(weather: WeatherSummary | null, isLoading: boolean): string {
  if (isLoading) {
    return "wird geladen";
  }
  if (!weather?.available) {
    return "nicht verfügbar";
  }
  if (weather.precipitation_hint) {
    return weather.precipitation_hint;
  }
  if (weather.summary && weather.temperature !== null) {
    return weather.summary.replace(`${Math.round(weather.temperature)}°C`, "").trim() || weather.summary;
  }
  return weather.summary || "aktuell";
}

function formatDashboardWeatherMeta(weather: WeatherSummary | null): string {
  const label = weather?.label ?? "Firmenzentrale";
  if (weather?.available && weather.wind_speed !== null) {
    return `Wind ${Math.round(weather.wind_speed)} km/h · ${label}`;
  }
  return label;
}

function formatWorkerSummaryBadgeLabel(group: WorkerSummaryGroup): string {
  return group.kind === "free" ? "O.Z." : group.manager.label;
}

function formatTodayAssignedMeta(sites: AssignedSiteSummary[]): string {
  const workerCount = sites.reduce((total, site) => total + site.internalCount + site.externalCount, 0);
  return `${formatCount(sites.length, "Baustelle", "Baustellen")} · ${formatCount(workerCount, "Monteur", "Monteure")}`;
}

function formatSiteTileMeta(siteSummary: AssignedSiteSummary): string {
  const workerCount = siteSummary.internalCount + siteSummary.externalCount;
  const workerLabel = `${workerCount} M`;
  return siteSummary.site.site_number ? `${workerLabel} · ${siteSummary.site.site_number}` : workerLabel;
}

function dashboardMessagesSignature(messages: MeasurementDashboardSubmission[]): string {
  return messages
    .map((message) => [
      message.message_key,
      message.message_type,
      message.event_at,
      message.submitted_at,
      message.customer_signed_at,
      message.status,
      message.title,
      message.site_name,
      message.site_number,
      message.submitted_by_name,
      message.customer_signature_name,
    ].join("|"))
    .join(";");
}

function formatMeasurementDashboardMessageTitle(message: MeasurementDashboardSubmission): string {
  if (message.message_type === "measurement_customer_signed") {
    return `${message.title} für ${message.site_name} wurde vom Kunden unterschrieben. Bitte prüfen.`;
  }
  return `${message.title} für ${message.site_name} wurde zur Prüfung eingereicht.`;
}

function getDashboardMessageLink(message: MeasurementDashboardSubmission): string {
  if (message.message_type === "extra_work_submitted") {
    return `/sites/${message.site_id}?tab=extra-work`;
  }
  return `/sites/${message.site_id}?tab=measurement&measurementSubtab=review`;
}

function formatMeasurementDashboardMessageMeta(message: MeasurementDashboardSubmission): string {
  const eventAt = message.event_at ?? message.customer_signed_at ?? message.submitted_at;
  const timeLabel = eventAt ? formatDashboardDateTime(eventAt) : "Zeitpunkt unbekannt";
  const siteLabel = message.site_number ? ` · ${message.site_number}` : "";
  if (message.message_type === "measurement_customer_signed") {
    const signerLabel = message.customer_signature_name
      ? `Unterschrieben von ${message.customer_signature_name}`
      : "Kundenunterschrift";
    return `${signerLabel} · ${timeLabel}${siteLabel}`;
  }
  const submitterLabel = message.submitted_by_name ? `Von ${message.submitted_by_name} · ` : "";
  return `${submitterLabel}${timeLabel}${siteLabel}`;
}

function formatDashboardDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function buildDashboardData(
  matrix: MatrixResponse,
  people: Person[],
  range: DateRange,
  overview: DashboardOverview | null,
): DashboardData {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const projectManagerIds = new Set<number>();
  matrix.rows.forEach((row) => {
    if (row.site.project_manager_person_id !== null) {
      projectManagerIds.add(row.site.project_manager_person_id);
    }
  });

  const activeWorkers = people.filter((person) => (
    person.is_active && person.person_type === "internal" && !projectManagerIds.has(person.id)
  ));

  const todayAssignedPersonIds = getAssignedPersonIdsForDate(matrix.rows, range.today);
  const todayAbsentPersonIds = getAbsentPersonIdsForDate(matrix.rows, range.today);
  const freeWorkers = activeWorkers.filter((person) => (
    !todayAssignedPersonIds.has(person.id) && !todayAbsentPersonIds.has(person.id)
  ));

  const lastManagerByPersonId = buildLastManagerByPersonId(matrix.rows, range.today);
  const freeWorkerGroups = groupFreeWorkersByLastManager(freeWorkers, lastManagerByPersonId);
  const workerSummaryGroups = overview?.workerSummaryGroups ?? buildWorkerSummaryGroupsForDay(matrix.rows, range.today, activeWorkers, freeWorkers);
  const todayAssignedSites = overview?.todayAssignedSites ?? getAssignedSitesForDay(matrix.rows, range.today, peopleById);
  const todayAssignedSiteGroups = overview?.todayAssignedSiteGroups ?? groupAssignedSitesByManager(todayAssignedSites);
  const openStaffingNeeds = overview?.openStaffingNeeds ?? getOpenStaffingNeeds(matrix.rows, range.today, range.nextWeekEnd);
  const conflicts = overview?.conflicts ?? getDashboardConflicts(matrix.rows, range.today, range.nextWeekEnd);
  const tomorrowAssignedCount = overview?.tomorrowAssignedCount ?? getAssignedSitesForDay(matrix.rows, range.tomorrow, peopleById).length;
  return {
    todayAssignedSites,
    todayAssignedSiteGroups,
    workerSummaryGroups,
    totalWorkerSummaryPeople: overview?.totalWorkerSummaryPeople ?? workerSummaryGroups.reduce((total, group) => total + group.people.length, 0),
    freeWorkerGroups,
    totalFreeWorkers: freeWorkers.length,
    openStaffingNeeds,
    conflicts,
    tomorrowAssignedCount,
    tomorrowOpenNeeds: overview?.tomorrowOpenNeeds ?? openStaffingNeeds.filter((need) => need.date === range.tomorrow),
    tomorrowConflicts: overview?.tomorrowConflicts ?? conflicts.filter((conflict) => conflict.date === range.tomorrow),
    currentWeekNeeds: overview?.currentWeekNeeds ?? openStaffingNeeds.filter((need) => need.date >= range.today && need.date <= range.weekEnd),
    nextWeekNeeds: overview?.nextWeekNeeds ?? openStaffingNeeds.filter((need) => need.date >= range.nextWeekStart && need.date <= range.nextWeekEnd),
  };
}

function getAssignedSitesForDay(
  rows: MatrixRow[],
  date: string,
  peopleById: Map<number, Person>,
): AssignedSiteSummary[] {
  return rows
    .map((row) => {
      const cell = row.cells.find((entry) => entry.date === date);
      const assignments = cell?.assignments ?? [];
      if (assignments.length === 0) {
        return null;
      }
      const externalCount = assignments.filter((assignment) => {
        const person = peopleById.get(assignment.person.id);
        return person ? person.person_type !== "internal" : false;
      }).length;
      return {
        site: row.site,
        managerLabel: getManagerLabel(row.site.project_manager),
        internalCount: assignments.length - externalCount,
        externalCount,
        hasWarnings: cell?.mark === "red" || cell?.mark === "orange",
      } satisfies AssignedSiteSummary;
    })
    .filter((summary): summary is AssignedSiteSummary => summary !== null)
    .sort(compareAssignedSites);
}

function groupAssignedSitesByManager(sites: AssignedSiteSummary[]): AssignedSiteGroup[] {
  const groups = new Map<string, AssignedSiteGroup>();
  sites.forEach((siteSummary) => {
    const manager = getManagerSummary(siteSummary.site.project_manager);
    const existing = groups.get(manager.key) ?? { manager, sites: [] };
    existing.sites.push(siteSummary);
    groups.set(manager.key, existing);
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      sites: group.sites.slice().sort(compareAssignedSites),
    }))
    .sort(compareAssignedSiteGroups);
}

function compareAssignedSiteGroups(first: AssignedSiteGroup, second: AssignedSiteGroup): number {
  if (first.manager.key === "unassigned" && second.manager.key !== "unassigned") {
    return 1;
  }
  if (second.manager.key === "unassigned" && first.manager.key !== "unassigned") {
    return -1;
  }
  return first.manager.label.localeCompare(second.manager.label, "de")
    || first.manager.name.localeCompare(second.manager.name, "de");
}

function compareAssignedSites(first: AssignedSiteSummary, second: AssignedSiteSummary): number {
  return compareSiteNumbers(first.site.site_number, second.site.site_number)
    || first.site.name.localeCompare(second.site.name, "de")
    || first.site.id - second.site.id;
}

function formatDashboardManagerHeading(manager: ManagerSummary): string {
  if (manager.key === "unassigned") {
    return "Ohne Projektleiter";
  }
  return `${manager.label} · ${manager.name}`;
}

function formatAssignedSiteGroupMeta(sites: AssignedSiteSummary[]): string {
  const workerCount = sites.reduce((total, site) => total + site.internalCount + site.externalCount, 0);
  return `${formatCount(sites.length, "Baustelle", "Baustellen")} · ${formatCount(workerCount, "Monteur", "Monteure")}`;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatWorkerSummaryPopoverTitle(group: WorkerSummaryGroup): string {
  if (group.kind === "free") {
    return "Ohne Zuordnung / nicht eingesetzt";
  }
  return `Eingesetzt - ${group.manager.label}`;
}

function formatWorkerSummaryGroupDetail(person: DashboardOverviewPerson, group: WorkerSummaryGroup): string {
  if (group.kind === "free") {
    return person.detail || "kein Einsatz heute";
  }
  return person.detail ? `${group.manager.label} · ${person.detail}` : group.manager.label;
}

function compareSiteNumbers(left: string | null, right: string | null): number {
  const leftNumber = parseSiteNumber(left);
  const rightNumber = parseSiteNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return (left ?? "").localeCompare(right ?? "", "de");
}

function parseSiteNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const matches = value.match(/\d+/g);
  return matches?.length ? Number(matches[matches.length - 1]) : null;
}

function groupFreeWorkersByLastManager(workers: Person[], lastManagerByPersonId: Map<number, ManagerSummary>): FreeWorkerGroup[] {
  const groups = new Map<string, FreeWorkerGroup>();

  workers.forEach((person) => {
    const manager = lastManagerByPersonId.get(person.id) ?? {
      key: "unassigned",
      label: "Ohne Zuordnung",
      name: "Ohne letzte Kalenderzuordnung",
    };
    const existing = groups.get(manager.key) ?? { manager, people: [] };
    existing.people.push(person);
    groups.set(manager.key, existing);
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      people: group.people.sort((first, second) => first.display_name.localeCompare(second.display_name, "de")),
    }))
    .sort((first, second) => first.manager.label.localeCompare(second.manager.label, "de"));
}

function buildWorkerSummaryGroupsForDay(
  rows: MatrixRow[],
  date: string,
  activeWorkers: Person[],
  freeWorkers: Person[],
): WorkerSummaryGroup[] {
  const activeWorkerById = new Map(activeWorkers.map((worker) => [worker.id, worker]));
  const assignedGroups = new Map<string, {
    manager: ManagerSummary;
    peopleById: Map<number, DashboardOverviewPerson & { siteLabels: Set<string> }>;
  }>();

  rows.forEach((row) => {
    const cell = row.cells.find((entry) => entry.date === date);
    if (!cell) {
      return;
    }
    if (cell.assignments.length === 0) {
      return;
    }
    const manager = getManagerSummary(row.site.project_manager);
    const group = assignedGroups.get(manager.key) ?? {
      manager,
      peopleById: new Map<number, DashboardOverviewPerson & { siteLabels: Set<string> }>(),
    };
    const siteLabel = formatWorkerSummarySiteLabel(row.site);
    cell.assignments.forEach((assignment) => {
      const worker = activeWorkerById.get(assignment.person.id);
      if (!worker) {
        return;
      }
      const person = group.peopleById.get(worker.id) ?? {
        ...toDashboardOverviewPerson(worker),
        siteLabels: new Set<string>(),
      };
      person.siteLabels.add(siteLabel);
      group.peopleById.set(worker.id, person);
    });
    assignedGroups.set(manager.key, group);
  });

  const groups: WorkerSummaryGroup[] = Array.from(assignedGroups.values()).map((group) => ({
    kind: "assigned" as const,
    manager: group.manager,
    people: Array.from(group.peopleById.values())
      .map((person) => {
        const { siteLabels, ...summary } = person;
        return {
          ...summary,
          detail: Array.from(siteLabels).sort((first, second) => first.localeCompare(second, "de")).join(", "),
        };
      })
      .sort(compareDashboardOverviewPeople),
  })).filter((group) => group.people.length > 0);

  if (freeWorkers.length > 0) {
    groups.push({
      kind: "free",
      manager: {
        key: "free-workers",
        label: "Ohne Zuordnung",
        name: "Nicht eingesetzte Monteure",
      },
      people: freeWorkers.map((person) => toDashboardOverviewPerson(person, "kein Einsatz heute")).sort(compareDashboardOverviewPeople),
    });
  }

  return groups.sort(compareWorkerSummaryGroups);
}

function toDashboardOverviewPerson(person: Person, detail?: string): DashboardOverviewPerson {
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    display_name: person.display_name,
    short_code: person.short_code,
    ...(detail ? { detail } : {}),
  };
}

function formatWorkerSummarySiteLabel(site: MatrixSite): string {
  return site.site_number ? `${site.site_number} - ${site.name}` : site.name;
}

function compareDashboardOverviewPeople(first: DashboardOverviewPerson, second: DashboardOverviewPerson): number {
  return first.display_name.localeCompare(second.display_name, "de") || first.id - second.id;
}

function compareWorkerSummaryGroups(first: WorkerSummaryGroup, second: WorkerSummaryGroup): number {
  if (first.kind === "free" && second.kind !== "free") {
    return 1;
  }
  if (second.kind === "free" && first.kind !== "free") {
    return -1;
  }
  return first.manager.label.localeCompare(second.manager.label, "de")
    || first.manager.name.localeCompare(second.manager.name, "de");
}

function buildLastManagerByPersonId(rows: MatrixRow[], date: string): Map<number, ManagerSummary> {
  const latestByPersonId = new Map<number, { date: string; manager: ManagerSummary }>();
  rows.forEach((row) => {
    const manager = getManagerSummary(row.site.project_manager);
    row.cells.forEach((cell) => {
      if (cell.date > date) {
        return;
      }
      cell.assignments.forEach((assignment) => {
        const existing = latestByPersonId.get(assignment.person.id);
        if (!existing || cell.date >= existing.date) {
          latestByPersonId.set(assignment.person.id, { date: cell.date, manager });
        }
      });
    });
  });
  return new Map(Array.from(latestByPersonId, ([personId, entry]) => [personId, entry.manager]));
}

function getOpenStaffingNeeds(rows: MatrixRow[], start: string, end: string): StaffingNeed[] {
  const needs: StaffingNeed[] = [];
  rows.forEach((row) => {
    row.cells.forEach((cell) => {
      if (cell.date < start || cell.date > end || cell.mark !== "orange" || cell.assignments.length > 0) {
        return;
      }
      needs.push({
        date: cell.date,
        siteName: row.site.name,
        siteNumber: row.site.site_number,
        managerLabel: getManagerLabel(row.site.project_manager),
      });
    });
  });
  return needs.sort((first, second) => first.date.localeCompare(second.date) || first.siteName.localeCompare(second.siteName, "de"));
}

function getDashboardConflicts(rows: MatrixRow[], start: string, end: string): DashboardConflict[] {
  const conflicts = new Map<string, DashboardConflict>();
  const assignmentsByDatePerson = new Map<string, { date: string; person: MatrixPerson; sites: Set<string> }>();
  const blockingAbsences = new Map<string, string>();

  rows.forEach((row) => {
    row.cells.forEach((cell) => {
      if (cell.date < start || cell.date > end) {
        return;
      }

      cell.absences.forEach((absence) => {
        if (absence.absence_type === "vacation" || absence.absence_type === "sick") {
          blockingAbsences.set(cell.date + ":" + absence.person.id, absence.absence_type === "vacation" ? "Urlaub" : "Krankheit");
        }
      });

      if ((row.site.status === "completed" || row.site.status === "deleted") && cell.assignments.length > 0) {
        const key = "inactive:" + row.site.id + ":" + cell.date;
        conflicts.set(key, {
          key,
          title: "Abgeschlossene Baustelle belegt",
          detail: row.site.name,
          severity: "hard",
          date: cell.date,
        });
      }

      cell.assignments.forEach((assignment) => {
        const bucketKey = cell.date + ":" + assignment.person.id;
        const existing = assignmentsByDatePerson.get(bucketKey) ?? {
          date: cell.date,
          person: assignment.person,
          sites: new Set<string>(),
        };
        existing.sites.add(row.site.name);
        assignmentsByDatePerson.set(bucketKey, existing);
      });
    });
  });

  assignmentsByDatePerson.forEach((entry, key) => {
    const absenceType = blockingAbsences.get(key);
    if (absenceType) {
      conflicts.set("absence:" + key, {
        key: "absence:" + key,
        title: absenceType + " + Einsatz",
        detail: entry.person.display_name + " · " + Array.from(entry.sites).join(", "),
        severity: "hard",
        date: entry.date,
      });
    }
    if (entry.sites.size > 2) {
      conflicts.set("overbooked:" + key, {
        key: "overbooked:" + key,
        title: "Mehr als zwei Einsaetze",
        detail: entry.person.display_name + " · " + entry.sites.size + " Baustellen",
        severity: "hard",
        date: entry.date,
      });
    }
  });

  return Array.from(conflicts.values()).sort((first, second) => first.date.localeCompare(second.date));
}

function getAssignedPersonIdsForDate(rows: MatrixRow[], date: string): Set<number> {
  const ids = new Set<number>();
  rows.forEach((row) => {
    const cell = row.cells.find((entry) => entry.date === date);
    cell?.assignments.forEach((assignment) => ids.add(assignment.person.id));
  });
  return ids;
}

function getAbsentPersonIdsForDate(rows: MatrixRow[], date: string): Set<number> {
  const ids = new Set<number>();
  rows.forEach((row) => {
    const cell = row.cells.find((entry) => entry.date === date);
    cell?.absences.forEach((absence) => ids.add(absence.person.id));
  });
  return ids;
}

function getManagerSummary(manager: MatrixPerson | null): ManagerSummary {
  if (!manager) {
    return { key: "unassigned", label: "Ohne PL", name: "Ohne Projektleiter" };
  }
  return {
    key: String(manager.id),
    label: getManagerLabel(manager),
    name: manager.display_name,
  };
}

function getManagerLabel(manager: MatrixPerson | null): string {
  if (!manager) {
    return "Ohne PL";
  }
  return normalizeShortCode(manager.short_code || manager.display_name);
}

function normalizeShortCode(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) {
    return "PL";
  }
  if (/^[A-Za-zÄÖÜäöüß]{1,4}$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  const parts = cleaned.replace(/\./g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

function getDashboardRange(referenceDate: Date): DateRange {
  const today = toDateKey(referenceDate);
  const weekStartDate = getWeekStart(referenceDate);
  const weekEndDate = addDays(weekStartDate, 6);
  const nextWeekStartDate = addDays(weekStartDate, 7);
  const nextWeekEndDate = addDays(weekStartDate, 13);
  return {
    historyStart: toDateKey(addDays(referenceDate, -35)),
    today,
    tomorrow: toDateKey(addDays(referenceDate, 1)),
    weekStart: toDateKey(weekStartDate),
    weekEnd: toDateKey(weekEndDate),
    nextWeekStart: toDateKey(nextWeekStartDate),
    nextWeekEnd: toDateKey(nextWeekEndDate),
  };
}

function getWeekStart(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = copy.getDay() === 0 ? 7 : copy.getDay();
  copy.setDate(copy.getDate() - weekday + 1);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parseDateKey(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(parseDateKey(value));
}

function getAbsenceLabel(value: string): string {
  const labels: Record<string, string> = {
    vacation: "Urlaub",
    sick: "Krank",
    school: "Schule",
    free: "Frei",
    other: "Sonstiges",
  };
  return labels[value] ?? value;
}
