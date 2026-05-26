import { AlertTriangle, BriefcaseBusiness, CalendarClock, CloudSun, Inbox, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ApiError, api } from "../lib/api";
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

type FreeWorkerGroup = {
  manager: ManagerSummary;
  people: Person[];
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

type WorkerLookup = {
  person: Person;
  status: string;
  detail: string;
  managerLabel: string;
};

type DashboardData = {
  todayAssignedSites: AssignedSiteSummary[];
  freeWorkerGroups: FreeWorkerGroup[];
  totalFreeWorkers: number;
  openStaffingNeeds: StaffingNeed[];
  conflicts: DashboardConflict[];
  tomorrowAssignedCount: number;
  tomorrowOpenNeeds: StaffingNeed[];
  tomorrowConflicts: DashboardConflict[];
  currentWeekNeeds: StaffingNeed[];
  nextWeekNeeds: StaffingNeed[];
  workerLookup: WorkerLookup[];
};

const MAX_PREVIEW_ITEMS = 6;

export function DashboardPage() {
  const { user } = useAuth();
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workerSearch, setWorkerSearch] = useState("");
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [measurementMessages, setMeasurementMessages] = useState<MeasurementDashboardSubmission[]>([]);

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
        const [matrixData, personData, measurementData] = await Promise.all([
          api.matrix({ start: range.historyStart, end: range.nextWeekEnd, includeWeekends: true }),
          api.persons({ isActive: true }),
          api.dashboardMeasurementSubmissions().catch(() => [] as MeasurementDashboardSubmission[]),
        ]);
        if (!active) {
          return;
        }
        setMatrix(matrixData);
        setPeople(personData);
        setMeasurementMessages(measurementData);
      } catch (loadError) {
        if (!active) {
          return;
        }
        const message = loadError instanceof ApiError
          ? "Dashboarddaten konnten nicht geladen werden."
          : "Dashboarddaten konnten nicht geladen werden.";
        setError(message);
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
  }, [range.historyStart, range.nextWeekEnd, user?.role]);

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

  const dashboard = useMemo(() => {
    if (!matrix) {
      return null;
    }
    return buildDashboardData(matrix, people, range);
  }, [matrix, people, range]);

  const filteredWorkers = useMemo(() => {
    if (!dashboard || !workerSearch.trim()) {
      return [];
    }
    const query = workerSearch.trim().toLowerCase();
    return dashboard.workerLookup
      .filter((entry) => {
        const person = entry.person;
        return [person.display_name, person.first_name, person.last_name, person.short_code]
          .some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, 5);
  }, [dashboard, workerSearch]);

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
          <p>Heute, morgen und die naechsten beiden Wochen auf einen Blick.</p>
        </div>
        <div className="dashboard-weather" aria-label="Wetter Firmenzentrale">
          <CloudSun aria-hidden="true" size={24} />
          <div>
            <span>Wetter Firmenzentrale</span>
            <strong>{weatherLoading ? "Wetter wird geladen..." : weather?.available ? weather.summary : "derzeit nicht verfuegbar"}</strong>
            <p>{weather?.label ?? "Firmenzentrale"}{weather?.is_cached ? " · aus Cache" : ""}</p>
          </div>
        </div>
        <div className="dashboard-free-summary">
          <span>Nicht eingesetzt</span>
          {dashboard ? (
            <>
              <strong>{dashboard.totalFreeWorkers} Monteure</strong>
              <div className="dashboard-pill-row">
                {dashboard.freeWorkerGroups.length > 0 ? dashboard.freeWorkerGroups.map((group) => (
                  <span className="dashboard-pill" key={group.manager.key} title={group.people.map((person) => person.display_name).join(", ")}>
                    {group.manager.label}: {group.people.length}
                  </span>
                )) : <span className="dashboard-muted">Keine freien Monteure erkannt</span>}
              </div>
            </>
          ) : <strong>{loading ? "Lade..." : "-"}</strong>}
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}
      {loading && <div className="empty-panel"><p>Dashboard wird geladen...</p></div>}

      {dashboard && !loading && (
        <>
          <div className="dashboard-main-grid">
            <DashboardCard title="Heute besetzte Baustellen" icon={<BriefcaseBusiness aria-hidden="true" size={20} />} className="dashboard-card-large">
              {dashboard.todayAssignedSites.length > 0 ? (
                <div className="dashboard-site-list">
                  {dashboard.todayAssignedSites.map((siteSummary) => (
                    <Link className="dashboard-site-item" to={"/sites/" + siteSummary.site.id} key={siteSummary.site.id}>
                      <span className="dashboard-site-color" style={{ backgroundColor: siteSummary.site.color ?? "#2f6ea8" }} aria-hidden="true" />
                      <span className="dashboard-site-body">
                        <strong>{siteSummary.site.name}</strong>
                        <span>
                          {siteSummary.managerLabel} · {siteSummary.internalCount} Monteure
                          {siteSummary.externalCount > 0 ? " · " + siteSummary.externalCount + " extern" : ""}
                        </span>
                        <small>{[siteSummary.site.site_number, siteSummary.site.location].filter(Boolean).join(" · ") || "Ohne Ort"}</small>
                      </span>
                      {siteSummary.hasWarnings && <span className="dashboard-signal signal-orange">Pruefen</span>}
                    </Link>
                  ))}
                </div>
              ) : <EmptyDashboardText text="Heute sind keine Baustellen besetzt." />}
            </DashboardCard>

            <DashboardCard title="Eingang / Meldungen" icon={<Inbox aria-hidden="true" size={20} />}>
              {measurementMessages.length > 0 ? (
                <div className="dashboard-alert-list">
                  {measurementMessages.map((message) => (
                    <Link
                      className="dashboard-alert-row dashboard-message-link"
                      key={message.batch_id}
                      to={`/sites/${message.site_id}?tab=measurement&measurementSubtab=review`}
                    >
                      <span className="dashboard-alert-dot signal-blue" aria-hidden="true" />
                      <div>
                        <strong>{message.title} für {message.site_name} wurde zur Prüfung eingereicht.</strong>
                        <span>
                          {message.submitted_by_name ? `Von ${message.submitted_by_name} · ` : ""}
                          {message.submitted_at ? formatDashboardDateTime(message.submitted_at) : "Zeitpunkt unbekannt"}
                          {message.site_number ? ` · ${message.site_number}` : ""}
                        </span>
                      </div>
                    </Link>
                  ))}
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

          <div className="dashboard-quick-bar">
            <div className="dashboard-search-box">
              <Search aria-hidden="true" size={18} />
              <input
                type="search"
                value={workerSearch}
                onChange={(event) => setWorkerSearch(event.target.value)}
                placeholder="Monteur suchen..."
              />
              {filteredWorkers.length > 0 && (
                <div className="dashboard-search-results">
                  {filteredWorkers.map((entry) => (
                    <div key={entry.person.id}>
                      <strong>{entry.person.display_name}</strong>
                      <span>{entry.status} · {entry.detail} · {entry.managerLabel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="dashboard-actions">
              <Link to="/sites"><Plus aria-hidden="true" size={16} /> Baustelle</Link>
              <Link to="/absences"><Plus aria-hidden="true" size={16} /> Abwesenheit</Link>
              <Link to="/matrix">Zur heutigen Kalenderwoche</Link>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function DashboardCard({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={["dashboard-card", className ?? ""].filter(Boolean).join(" ")}>
      <div className="dashboard-card-header">
        <span>{icon}</span>
        <h2>{title}</h2>
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

function formatDashboardDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function buildDashboardData(matrix: MatrixResponse, people: Person[], range: DateRange): DashboardData {
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

  const freeWorkerGroups = groupFreeWorkersByLastManager(matrix.rows, freeWorkers, range.today);
  const openStaffingNeeds = getOpenStaffingNeeds(matrix.rows, range.today, range.nextWeekEnd);
  const conflicts = getDashboardConflicts(matrix.rows, range.today, range.nextWeekEnd);
  const tomorrowAssignedSites = getAssignedSitesForDay(matrix.rows, range.tomorrow, peopleById);
  const workerLookup = buildWorkerLookup(matrix.rows, activeWorkers, range.today);

  return {
    todayAssignedSites: getAssignedSitesForDay(matrix.rows, range.today, peopleById),
    freeWorkerGroups,
    totalFreeWorkers: freeWorkers.length,
    openStaffingNeeds,
    conflicts,
    tomorrowAssignedCount: tomorrowAssignedSites.length,
    tomorrowOpenNeeds: openStaffingNeeds.filter((need) => need.date === range.tomorrow),
    tomorrowConflicts: conflicts.filter((conflict) => conflict.date === range.tomorrow),
    currentWeekNeeds: openStaffingNeeds.filter((need) => need.date >= range.today && need.date <= range.weekEnd),
    nextWeekNeeds: openStaffingNeeds.filter((need) => need.date >= range.nextWeekStart && need.date <= range.nextWeekEnd),
    workerLookup,
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
    .sort((first, second) => first.managerLabel.localeCompare(second.managerLabel, "de") || first.site.name.localeCompare(second.site.name, "de"));
}

function groupFreeWorkersByLastManager(rows: MatrixRow[], workers: Person[], date: string): FreeWorkerGroup[] {
  const groups = new Map<string, FreeWorkerGroup>();

  workers.forEach((person) => {
    const manager = findLastManagerForPerson(rows, person.id, date) ?? {
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

function findLastManagerForPerson(rows: MatrixRow[], personId: number, date: string): ManagerSummary | null {
  let latestDate: string | null = null;
  let latestManager: ManagerSummary | null = null;

  rows.forEach((row) => {
    row.cells.forEach((cell) => {
      if (cell.date > date || (latestDate !== null && cell.date < latestDate)) {
        return;
      }
      const hasPerson = cell.assignments.some((assignment) => assignment.person.id === personId);
      if (!hasPerson) {
        return;
      }
      latestDate = cell.date;
      latestManager = getManagerSummary(row.site.project_manager);
    });
  });

  return latestManager;
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

function buildWorkerLookup(rows: MatrixRow[], workers: Person[], date: string): WorkerLookup[] {
  const assignedToday = new Map<number, { siteName: string; managerLabel: string }>();
  const absentToday = new Map<number, string>();

  rows.forEach((row) => {
    const cell = row.cells.find((entry) => entry.date === date);
    if (!cell) {
      return;
    }
    cell.assignments.forEach((assignment) => {
      assignedToday.set(assignment.person.id, {
        siteName: row.site.name,
        managerLabel: getManagerLabel(row.site.project_manager),
      });
    });
    cell.absences.forEach((absence) => {
      absentToday.set(absence.person.id, absence.absence_type);
    });
  });

  return workers.map((person) => {
    const assignment = assignedToday.get(person.id);
    if (assignment) {
      return {
        person,
        status: "Eingesetzt",
        detail: assignment.siteName,
        managerLabel: assignment.managerLabel,
      };
    }
    const absence = absentToday.get(person.id);
    if (absence) {
      return {
        person,
        status: "Abwesend",
        detail: getAbsenceLabel(absence),
        managerLabel: findLastManagerForPerson(rows, person.id, date)?.label ?? "Ohne Zuordnung",
      };
    }
    return {
      person,
      status: "Frei",
      detail: "kein Einsatz heute",
      managerLabel: findLastManagerForPerson(rows, person.id, date)?.label ?? "Ohne Zuordnung",
    };
  }).sort((first, second) => first.person.display_name.localeCompare(second.person.display_name, "de"));
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
