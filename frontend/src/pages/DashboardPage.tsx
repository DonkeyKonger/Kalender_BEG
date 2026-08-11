import { AlertTriangle, BriefcaseBusiness, Check, ClipboardList, Clock, CloudSun, Inbox, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import {
  DashboardNoteEmployeeSelect,
  DashboardNoteShareUserSelect,
  DashboardNoteSiteSelect,
  DashboardOperationalAbsenceProjectManagerSelect,
} from "../components/DashboardNotePickers";
import {
  api,
  type DashboardMessage,
  type DashboardNote,
  type DashboardNotePayload,
  type DashboardNoteUser,
  type DashboardOverview,
  type DashboardOverviewPerson,
  type OperationalAbsenceProjectManager,
  type OperationalAbsenceSite,
} from "../lib/api";
import {
  EMPTY_OPERATIONAL_ABSENCE_DRAFT,
  operationalAbsencePayloadFromDraft,
  publishOperationalAbsencesUpdated,
  type OperationalAbsenceDraft,
} from "../lib/operationalAbsence";
import { compareSiteNumbers } from "../lib/siteSorting";
import { buildToolMaterialIssuePath } from "../lib/toolMaterialRouting";
import type { MatrixPerson, MatrixResponse, MatrixRow, MatrixSite } from "../types/matrix";
import { calendarPersonCode, type Person } from "../types/person";
import type { SiteSummary } from "../types/site";
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

type DashboardDateRangeGroup<T> = {
  item: T;
  startDate: string;
  endDate: string;
};

type DashboardAlertListItem =
  | { kind: "conflict"; range: DashboardDateRangeGroup<DashboardConflict> }
  | { kind: "need"; range: DashboardDateRangeGroup<StaffingNeed> };

type DashboardMessageMetaItem = {
  key: string;
  label: string;
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

type DashboardNoteMode = "open" | "completed";
type DashboardEditorMode = "note" | "operational_absence" | null;

type DashboardNoteDraft = {
  text: string;
  due_date: string;
  site_id: string;
  employee_id: string;
  shared_with_user_id: string;
};

const MAX_PREVIEW_ITEMS = 6;
const DASHBOARD_MESSAGES_UPDATED_EVENT = "dashboard-messages-updated";
const DASHBOARD_MESSAGE_READ_EVENT = "dashboard-message-read";
const FREE_WORKER_ALL_KEY = "__all__";
const DASHBOARD_NOTE_SITE_FILTER_PARAM = "noteSiteId";
const EMPTY_DASHBOARD_NOTE_DRAFT: DashboardNoteDraft = {
  text: "",
  due_date: "",
  site_id: "",
  employee_id: "",
  shared_with_user_id: "",
};

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const dashboardNoteSiteFilterId = parseDashboardNoteSiteFilterId(
    searchParams.get(DASHBOARD_NOTE_SITE_FILTER_PARAM),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [dashboardMessages, setDashboardMessages] = useState<DashboardMessage[]>([]);
  const [dashboardOverview, setDashboardOverview] = useState<DashboardOverview | null>(null);
  const [dashboardNotes, setDashboardNotes] = useState<DashboardNote[]>([]);
  const [dashboardNoteSites, setDashboardNoteSites] = useState<SiteSummary[]>([]);
  const [dashboardNoteSitesLoading, setDashboardNoteSitesLoading] = useState(false);
  const [dashboardNoteSitesError, setDashboardNoteSitesError] = useState<string | null>(null);
  const [dashboardNotePeople, setDashboardNotePeople] = useState<Person[]>([]);
  const [dashboardNotePeopleLoading, setDashboardNotePeopleLoading] = useState(false);
  const [dashboardNotePeopleError, setDashboardNotePeopleError] = useState<string | null>(null);
  const [dashboardNoteShareUsers, setDashboardNoteShareUsers] = useState<DashboardNoteUser[]>([]);
  const [dashboardNoteShareUsersLoading, setDashboardNoteShareUsersLoading] = useState(false);
  const [dashboardNoteShareUsersError, setDashboardNoteShareUsersError] = useState<string | null>(null);
  const [dashboardNotesLoading, setDashboardNotesLoading] = useState(false);
  const [dashboardNoteMode, setDashboardNoteMode] = useState<DashboardNoteMode>("open");
  const [dashboardEditorMode, setDashboardEditorMode] = useState<DashboardEditorMode>(null);
  const [editingDashboardNoteId, setEditingDashboardNoteId] = useState<number | null>(null);
  const [dashboardNoteDraft, setDashboardNoteDraft] = useState<DashboardNoteDraft>(EMPTY_DASHBOARD_NOTE_DRAFT);
  const [dashboardNoteSaving, setDashboardNoteSaving] = useState(false);
  const [dashboardNoteError, setDashboardNoteError] = useState<string | null>(null);
  const [dashboardNoteBusyId, setDashboardNoteBusyId] = useState<number | null>(null);
  const [operationalAbsenceDraft, setOperationalAbsenceDraft] = useState<OperationalAbsenceDraft>(
    EMPTY_OPERATIONAL_ABSENCE_DRAFT,
  );
  const [operationalAbsenceProjectManagers, setOperationalAbsenceProjectManagers] = useState<OperationalAbsenceProjectManager[]>([]);
  const [operationalAbsenceProjectManagersLoading, setOperationalAbsenceProjectManagersLoading] = useState(false);
  const [operationalAbsenceProjectManagersError, setOperationalAbsenceProjectManagersError] = useState<string | null>(null);
  const [operationalAbsenceSites, setOperationalAbsenceSites] = useState<OperationalAbsenceSite[]>([]);
  const [operationalAbsenceSitesLoading, setOperationalAbsenceSitesLoading] = useState(false);
  const [operationalAbsenceSitesError, setOperationalAbsenceSitesError] = useState<string | null>(null);
  const [operationalAbsenceSaving, setOperationalAbsenceSaving] = useState(false);
  const [operationalAbsenceError, setOperationalAbsenceError] = useState<string | null>(null);
  const [dismissingMessageKey, setDismissingMessageKey] = useState<string | null>(null);
  const [openedDashboardMessageNote, setOpenedDashboardMessageNote] = useState<DashboardNote | null>(null);
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
          api.dashboardMessagesSummary().then((summary) => summary.latest_messages).catch(() => [] as DashboardMessage[]),
        ]);
        if (!active) {
          return;
        }
        setDashboardOverview(overviewData);
        setDashboardMessages(measurementData);
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
    let active = true;

    if (user?.role === "monteur") {
      return undefined;
    }

    async function loadDashboardNotes() {
      setDashboardNotesLoading(true);
      setDashboardNoteError(null);
      try {
        const notes = await api.dashboardNotes();
        if (!active) {
          return;
        }
        setDashboardNotes(notes);
      } catch {
        if (active) {
          setDashboardNoteError("Notizen konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setDashboardNotesLoading(false);
        }
      }
    }

    async function loadDashboardNotePeople() {
      setDashboardNotePeopleLoading(true);
      setDashboardNotePeopleError(null);
      try {
        const people = await api.persons({ isActive: true });
        if (active) {
          setDashboardNotePeople(
            people.filter(isAssignableDashboardNotePerson).sort(compareDashboardNotePeople),
          );
        }
      } catch {
        if (active) {
          setDashboardNotePeople([]);
          setDashboardNotePeopleError("Mitarbeiter konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setDashboardNotePeopleLoading(false);
        }
      }
    }

    async function loadDashboardNoteSites() {
      setDashboardNoteSitesLoading(true);
      setDashboardNoteSitesError(null);
      try {
        const sites = await api.dashboardNoteSiteOptions();
        if (active) {
          setDashboardNoteSites(sites.slice().sort(compareDashboardNoteSites));
        }
      } catch {
        if (active) {
          setDashboardNoteSites([]);
          setDashboardNoteSitesError("Baustellen konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setDashboardNoteSitesLoading(false);
        }
      }
    }

    async function loadDashboardNoteShareUsers() {
      setDashboardNoteShareUsersLoading(true);
      setDashboardNoteShareUsersError(null);
      try {
        const users = await api.dashboardNoteShareUserOptions();
        if (active) {
          setDashboardNoteShareUsers(users);
        }
      } catch {
        if (active) {
          setDashboardNoteShareUsers([]);
          setDashboardNoteShareUsersError("Büronutzer konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setDashboardNoteShareUsersLoading(false);
        }
      }
    }

    async function loadOperationalAbsenceProjectManagers() {
      setOperationalAbsenceProjectManagersLoading(true);
      setOperationalAbsenceProjectManagersError(null);
      try {
        const projectManagers = await api.operationalAbsenceProjectManagers();
        if (active) {
          setOperationalAbsenceProjectManagers(projectManagers);
        }
      } catch {
        if (active) {
          setOperationalAbsenceProjectManagers([]);
          setOperationalAbsenceProjectManagersError("Projektleiter konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setOperationalAbsenceProjectManagersLoading(false);
        }
      }
    }

    async function loadOperationalAbsenceSites() {
      setOperationalAbsenceSitesLoading(true);
      setOperationalAbsenceSitesError(null);
      try {
        const sites = await api.operationalAbsenceSiteOptions();
        if (active) {
          setOperationalAbsenceSites(sites.slice().sort(compareDashboardNoteSites));
        }
      } catch {
        if (active) {
          setOperationalAbsenceSites([]);
          setOperationalAbsenceSitesError("Baustellen konnten nicht geladen werden.");
        }
      } finally {
        if (active) {
          setOperationalAbsenceSitesLoading(false);
        }
      }
    }

    void loadDashboardNotes();
    void loadDashboardNotePeople();
    void loadDashboardNoteSites();
    void loadDashboardNoteShareUsers();
    void loadOperationalAbsenceProjectManagers();
    void loadOperationalAbsenceSites();

    return () => {
      active = false;
    };
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (dashboardNoteSiteFilterId === null || loading || !dashboardOverview) {
      return undefined;
    }
    setDashboardNoteMode("open");
    const frameId = window.requestAnimationFrame(() => {
      document.getElementById("dashboard-notes")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [dashboardNoteSiteFilterId, dashboardOverview, loading]);

  useEffect(() => {
    function handleDashboardMessagesUpdated(event: Event) {
      const messages = (event as CustomEvent<DashboardMessage[]>).detail;
      if (Array.isArray(messages)) {
        setDashboardMessages((current) => (
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
  const siteFilteredDashboardNotes = useMemo(
    () => dashboardNoteSiteFilterId === null
      ? dashboardNotes
      : dashboardNotes.filter((note) => note.site_id === dashboardNoteSiteFilterId),
    [dashboardNoteSiteFilterId, dashboardNotes],
  );
  const visibleDashboardNotes = useMemo(
    () => sortDashboardNotes(
      siteFilteredDashboardNotes.filter((note) => dashboardNoteMode === "completed" ? note.completed : !note.completed),
      dashboardNoteMode,
    ),
    [dashboardNoteMode, siteFilteredDashboardNotes],
  );
  const openDashboardNoteCount = siteFilteredDashboardNotes.filter((note) => !note.completed).length;
  const completedDashboardNoteCount = siteFilteredDashboardNotes.filter((note) => note.completed).length;
  const dashboardNoteSiteFilterLabel = dashboardNoteSiteFilterId === null
    ? null
    : dashboardNoteSites.find((site) => site.id === dashboardNoteSiteFilterId)?.name
      ?? dashboardNotes.find((note) => note.site_id === dashboardNoteSiteFilterId)?.site?.name
      ?? `Baustelle ${dashboardNoteSiteFilterId}`;
  const dashboardGreeting = formatDashboardGreeting(user?.display_name || user?.username || "");
  const allSummaryWorkers = workerSummaryGroups.flatMap((group) => (
    group.people.map((person) => ({
      ...person,
      detail: formatWorkerSummaryGroupDetail(person, group),
    }))
  ));

  function toggleFreeWorkerPopover(key: string): void {
    setOpenFreeWorkerKey((current) => current === key ? null : key);
  }

  async function dismissDashboardMessage(message: DashboardMessage): Promise<void> {
    if (dismissingMessageKey) {
      return;
    }
    const previousMessages = dashboardMessages;
    setDismissingMessageKey(message.message_key);
    setDashboardMessages((current) => current.filter((entry) => entry.message_key !== message.message_key));
    try {
      await api.dismissDashboardMessage(message.message_key);
    } catch {
      setDashboardMessages(previousMessages);
    } finally {
      setDismissingMessageKey(null);
    }
  }

  async function openSharedDashboardNoteMessage(message: DashboardMessage): Promise<void> {
    if (message.note_id === null || dismissingMessageKey !== null) {
      return;
    }
    setDismissingMessageKey(message.message_key);
    setDashboardNoteError(null);
    try {
      const note = await api.dashboardNote(message.note_id);
      setDashboardNotes((current) => upsertDashboardNote(current, note));
      setOpenedDashboardMessageNote(note);
      await api.dismissDashboardMessage(message.message_key);
      setDashboardMessages((current) => (
        current.filter((entry) => entry.message_key !== message.message_key)
      ));
    } catch {
      setDashboardNoteError("Die geteilte Notiz konnte nicht geöffnet werden.");
    } finally {
      setDismissingMessageKey(null);
    }
  }

  async function openToolIssueMessage(message: DashboardMessage): Promise<void> {
    if (message.tool_id === null || dismissingMessageKey) return;
    setDismissingMessageKey(message.message_key);
    try {
      await api.dismissDashboardMessage(message.message_key);
      setDashboardMessages((current) => current.filter((entry) => entry.message_key !== message.message_key));
      window.dispatchEvent(new Event(DASHBOARD_MESSAGE_READ_EVENT));
      navigate(buildToolMaterialIssuePath(message.tool_id));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Die Werkzeugmeldung konnte nicht geöffnet werden.",
      );
    } finally {
      setDismissingMessageKey(null);
    }
  }

  function openDashboardNoteCreateForm(): void {
    setDashboardNoteDraft(EMPTY_DASHBOARD_NOTE_DRAFT);
    setEditingDashboardNoteId(null);
    setDashboardEditorMode("note");
    setDashboardNoteError(null);
    setOperationalAbsenceError(null);
  }

  function openOperationalAbsenceCreateForm(): void {
    setOperationalAbsenceDraft({
      ...EMPTY_OPERATIONAL_ABSENCE_DRAFT,
      date: range.today,
    });
    setEditingDashboardNoteId(null);
    setDashboardEditorMode("operational_absence");
    setDashboardNoteError(null);
    setOperationalAbsenceError(null);
  }

  function editDashboardNote(note: DashboardNote): void {
    setDashboardNoteDraft({
      text: note.text,
      due_date: note.due_date ?? "",
      site_id: note.site_id === null ? "" : String(note.site_id),
      employee_id: note.employee_id === null ? "" : String(note.employee_id),
      shared_with_user_id: note.shared_with_user_id === null ? "" : String(note.shared_with_user_id),
    });
    setEditingDashboardNoteId(note.id);
    setDashboardEditorMode("note");
    setDashboardNoteError(null);
    setOperationalAbsenceError(null);
  }

  function cancelDashboardEditor(): void {
    setDashboardEditorMode(null);
    setEditingDashboardNoteId(null);
    setDashboardNoteDraft(EMPTY_DASHBOARD_NOTE_DRAFT);
    setOperationalAbsenceDraft(EMPTY_OPERATIONAL_ABSENCE_DRAFT);
    setDashboardNoteError(null);
    setOperationalAbsenceError(null);
  }

  function updateDashboardNoteDraft(field: keyof DashboardNoteDraft, value: string): void {
    setDashboardNoteDraft((current) => ({ ...current, [field]: value }));
  }

  function updateOperationalAbsenceDraft(field: keyof OperationalAbsenceDraft, value: string): void {
    setOperationalAbsenceDraft((current) => ({ ...current, [field]: value }));
  }

  function clearDashboardNoteSiteFilter(): void {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete(DASHBOARD_NOTE_SITE_FILTER_PARAM);
    setSearchParams(nextSearchParams, { replace: true });
  }

  async function saveDashboardNote(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (dashboardNoteSaving) {
      return;
    }
    const editingNote = editingDashboardNoteId === null
      ? null
      : dashboardNotes.find((note) => note.id === editingDashboardNoteId) ?? null;
    const canManageShare = editingNote === null || editingNote.created_by_user_id === user?.id;
    const payload = dashboardNotePayloadFromDraft(dashboardNoteDraft, canManageShare);
    if (!payload.text) {
      setDashboardNoteError("Bitte einen Notiztext eingeben.");
      return;
    }
    setDashboardNoteSaving(true);
    setDashboardNoteError(null);
    try {
      const savedNote = editingDashboardNoteId === null
        ? await api.createDashboardNote(payload)
        : await api.updateDashboardNote(editingDashboardNoteId, payload);
      setDashboardNotes((current) => upsertDashboardNote(current, savedNote));
      setDashboardEditorMode(null);
      setEditingDashboardNoteId(null);
      setDashboardNoteDraft(EMPTY_DASHBOARD_NOTE_DRAFT);
    } catch {
      setDashboardNoteError("Notiz konnte nicht gespeichert werden.");
    } finally {
      setDashboardNoteSaving(false);
    }
  }

  async function saveOperationalAbsence(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (operationalAbsenceSaving) {
      return;
    }
    const result = operationalAbsencePayloadFromDraft(operationalAbsenceDraft);
    if (result.payload === null) {
      setOperationalAbsenceError(result.error);
      return;
    }
    setOperationalAbsenceSaving(true);
    setOperationalAbsenceError(null);
    try {
      await api.createOperationalAbsence(result.payload);
      publishOperationalAbsencesUpdated();
      setDashboardEditorMode(null);
      setOperationalAbsenceDraft(EMPTY_OPERATIONAL_ABSENCE_DRAFT);
    } catch (requestError) {
      setOperationalAbsenceError(
        requestError instanceof Error
          ? requestError.message
          : "Abwesenheit konnte nicht gespeichert werden.",
      );
    } finally {
      setOperationalAbsenceSaving(false);
    }
  }

  async function toggleDashboardNoteCompleted(note: DashboardNote): Promise<void> {
    if (dashboardNoteBusyId !== null) {
      return;
    }
    setDashboardNoteBusyId(note.id);
    setDashboardNoteError(null);
    try {
      const updatedNote = await api.updateDashboardNote(note.id, { completed: !note.completed });
      setDashboardNotes((current) => upsertDashboardNote(current, updatedNote));
      setOpenedDashboardMessageNote((current) => current?.id === note.id ? updatedNote : current);
    } catch {
      setDashboardNoteError("Notiz konnte nicht aktualisiert werden.");
    } finally {
      setDashboardNoteBusyId(null);
    }
  }

  async function deleteDashboardNote(note: DashboardNote): Promise<void> {
    if (dashboardNoteBusyId !== null) {
      return;
    }
    const previousNotes = dashboardNotes;
    setDashboardNoteBusyId(note.id);
    setDashboardNoteError(null);
    setDashboardNotes((current) => current.filter((entry) => entry.id !== note.id));
    try {
      await api.deleteDashboardNote(note.id);
      setOpenedDashboardMessageNote((current) => current?.id === note.id ? null : current);
      if (editingDashboardNoteId === note.id) {
        cancelDashboardEditor();
      }
    } catch {
      setDashboardNotes(previousNotes);
      setDashboardNoteError("Notiz konnte nicht gelöscht werden.");
    } finally {
      setDashboardNoteBusyId(null);
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
          <p className="eyebrow dashboard-greeting">{dashboardGreeting}</p>
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
          <div className="dashboard-main-grid dashboard-main-grid-primary">
            <DashboardCard
              title="Heute besetzte Baustellen"
              icon={<BriefcaseBusiness aria-hidden="true" size={20} />}
              meta={formatTodayAssignedMeta(dashboard.todayAssignedSites)}
              className="dashboard-card-large dashboard-section--sites"
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
                            {siteSummary.hasWarnings && <span className="dashboard-signal signal-orange">Prüfen</span>}
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
              badge={dashboardMessages.length > 0 ? String(dashboardMessages.length) : undefined}
              className="dashboard-card-messages dashboard-section--messages"
            >
              {dashboardMessages.length > 0 ? (
                <div className="dashboard-alert-list">
                  {dashboardMessages.map((message) => {
                    const metaItems = getDashboardMessageMetaItems(message);
                    const messageContent = (
                      <div className="dashboard-message-content">
                        <strong>{formatDashboardMessageTitle(message)}</strong>
                        {message.note_preview || message.message_text ? (
                          <span className="dashboard-message-preview">{message.note_preview ?? message.message_text}</span>
                        ) : null}
                        <span className="dashboard-message-meta">
                          <Clock aria-hidden="true" size={13} />
                          {metaItems.map((item, index) => (
                            <span className="dashboard-message-meta-part" key={item.key}>
                              {index > 0 ? <span className="dashboard-message-meta-separator" aria-hidden="true">·</span> : null}
                              {item.label}
                            </span>
                          ))}
                        </span>
                      </div>
                    );
                    return (
                      <div className="dashboard-alert-row dashboard-message-row" key={message.message_key}>
                        <span className="dashboard-message-accent" aria-hidden="true" />
                        <div className="dashboard-message-stack">
                          {message.message_type === "dashboard_note_shared" ? (
                            <button
                              className="dashboard-message-link is-button"
                              disabled={dismissingMessageKey === message.message_key}
                              type="button"
                              onClick={() => void openSharedDashboardNoteMessage(message)}
                            >
                              {messageContent}
                            </button>
                          ) : message.message_type === "tool_issue_reported" ? (
                            <button
                              className="dashboard-message-link is-button"
                              disabled={dismissingMessageKey === message.message_key}
                              type="button"
                              onClick={() => void openToolIssueMessage(message)}
                            >
                              {messageContent}
                            </button>
                          ) : (
                            <Link className="dashboard-message-link" to={getDashboardMessageLink(message)}>
                              {messageContent}
                            </Link>
                          )}
                          <button
                            type="button"
                            className="dashboard-message-read-button"
                            aria-label={message.message_type === "tool_issue_reported"
                              ? "Werkzeugmeldung als erledigt markieren"
                              : "Meldung als gelesen markieren"}
                            disabled={dismissingMessageKey === message.message_key}
                            onClick={() => void dismissDashboardMessage(message)}
                          >
                            {message.message_type === "tool_issue_reported"
                              ? "Als erledigt markieren"
                              : "Als gelesen markieren"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="dashboard-message-box">
                  <strong>Keine neuen Meldungen</strong>
                </div>
              )}
            </DashboardCard>

            <DashboardCard
              title="Notizen"
              icon={<ClipboardList aria-hidden="true" size={20} />}
              className="dashboard-card-notes dashboard-section--notes"
            >
              <div className="dashboard-note-action-row" aria-label="Notizaktionen">
                <button
                  aria-controls="dashboard-note-editor"
                  aria-expanded={dashboardEditorMode === "operational_absence"}
                  type="button"
                  className="dashboard-note-add-button"
                  onClick={openOperationalAbsenceCreateForm}
                >
                  <Plus aria-hidden="true" size={15} />
                  Abwesenheit hinzufügen
                </button>
                <button
                  aria-controls="dashboard-note-editor"
                  aria-expanded={dashboardEditorMode === "note"}
                  type="button"
                  className="dashboard-note-add-button"
                  onClick={openDashboardNoteCreateForm}
                >
                  <Plus aria-hidden="true" size={15} />
                  Notiz hinzufügen
                </button>
              </div>
              <DashboardNotesPanel
                editorMode={dashboardEditorMode}
                busyNoteId={dashboardNoteBusyId}
                completedCount={completedDashboardNoteCount}
                draft={dashboardNoteDraft}
                editingNoteId={editingDashboardNoteId}
                error={dashboardNoteError}
                loading={dashboardNotesLoading}
                mode={dashboardNoteMode}
                notes={visibleDashboardNotes}
                operationalAbsenceDraft={operationalAbsenceDraft}
                operationalAbsenceError={operationalAbsenceError}
                operationalAbsenceProjectManagers={operationalAbsenceProjectManagers}
                operationalAbsenceProjectManagersError={operationalAbsenceProjectManagersError}
                operationalAbsenceProjectManagersLoading={operationalAbsenceProjectManagersLoading}
                operationalAbsenceSaving={operationalAbsenceSaving}
                operationalAbsenceSites={operationalAbsenceSites}
                operationalAbsenceSitesError={operationalAbsenceSitesError}
                operationalAbsenceSitesLoading={operationalAbsenceSitesLoading}
                openCount={openDashboardNoteCount}
                people={dashboardNotePeople}
                peopleError={dashboardNotePeopleError}
                peopleLoading={dashboardNotePeopleLoading}
                shareUsers={dashboardNoteShareUsers}
                shareUsersError={dashboardNoteShareUsersError}
                shareUsersLoading={dashboardNoteShareUsersLoading}
                saving={dashboardNoteSaving}
                siteFilterLabel={dashboardNoteSiteFilterLabel}
                sites={dashboardNoteSites}
                sitesError={dashboardNoteSitesError}
                sitesLoading={dashboardNoteSitesLoading}
                today={range.today}
                currentUserId={user?.id ?? null}
                onCancel={cancelDashboardEditor}
                onClearSiteFilter={clearDashboardNoteSiteFilter}
                onDelete={(note) => void deleteDashboardNote(note)}
                onDraftChange={updateDashboardNoteDraft}
                onEdit={editDashboardNote}
                onModeChange={setDashboardNoteMode}
                onOperationalAbsenceDraftChange={updateOperationalAbsenceDraft}
                onOperationalAbsenceSubmit={(event) => void saveOperationalAbsence(event)}
                onSubmit={(event) => void saveDashboardNote(event)}
                onToggle={(note) => void toggleDashboardNoteCompleted(note)}
              />
            </DashboardCard>
          </div>

          <div className="dashboard-main-grid dashboard-main-grid-secondary">
            <DashboardCard
              title="Prüfen / Konflikte"
              icon={<AlertTriangle aria-hidden="true" size={20} />}
              className="dashboard-section--conflicts"
            >
              <DashboardConflictList conflicts={dashboard.conflicts} needs={dashboard.openStaffingNeeds} />
            </DashboardCard>
          </div>

          {openedDashboardMessageNote ? (
            <DashboardNoteDetailModal
              busy={dashboardNoteBusyId === openedDashboardMessageNote.id}
              currentUserId={user?.id ?? null}
              note={openedDashboardMessageNote}
              today={range.today}
              onClose={() => setOpenedDashboardMessageNote(null)}
              onDelete={(note) => void deleteDashboardNote(note)}
              onEdit={(note) => {
                setOpenedDashboardMessageNote(null);
                editDashboardNote(note);
                window.requestAnimationFrame(() => {
                  document.getElementById("dashboard-notes")?.scrollIntoView({ block: "start" });
                });
              }}
              onToggle={(note) => void toggleDashboardNoteCompleted(note)}
            />
          ) : null}
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

function DashboardNotesPanel({
  notes,
  mode,
  editorMode,
  openCount,
  completedCount,
  loading,
  error,
  draft,
  editingNoteId,
  saving,
  busyNoteId,
  sites,
  sitesError,
  sitesLoading,
  people,
  peopleError,
  peopleLoading,
  shareUsers,
  shareUsersError,
  shareUsersLoading,
  operationalAbsenceDraft,
  operationalAbsenceError,
  operationalAbsenceProjectManagers,
  operationalAbsenceProjectManagersError,
  operationalAbsenceProjectManagersLoading,
  operationalAbsenceSaving,
  operationalAbsenceSites,
  operationalAbsenceSitesError,
  operationalAbsenceSitesLoading,
  siteFilterLabel,
  today,
  currentUserId,
  onModeChange,
  onDraftChange,
  onSubmit,
  onCancel,
  onClearSiteFilter,
  onToggle,
  onEdit,
  onDelete,
  onOperationalAbsenceDraftChange,
  onOperationalAbsenceSubmit,
}: {
  notes: DashboardNote[];
  mode: DashboardNoteMode;
  editorMode: DashboardEditorMode;
  openCount: number;
  completedCount: number;
  loading: boolean;
  error: string | null;
  draft: DashboardNoteDraft;
  editingNoteId: number | null;
  saving: boolean;
  busyNoteId: number | null;
  sites: SiteSummary[];
  sitesError: string | null;
  sitesLoading: boolean;
  people: Person[];
  peopleError: string | null;
  peopleLoading: boolean;
  shareUsers: DashboardNoteUser[];
  shareUsersError: string | null;
  shareUsersLoading: boolean;
  operationalAbsenceDraft: OperationalAbsenceDraft;
  operationalAbsenceError: string | null;
  operationalAbsenceProjectManagers: OperationalAbsenceProjectManager[];
  operationalAbsenceProjectManagersError: string | null;
  operationalAbsenceProjectManagersLoading: boolean;
  operationalAbsenceSaving: boolean;
  operationalAbsenceSites: OperationalAbsenceSite[];
  operationalAbsenceSitesError: string | null;
  operationalAbsenceSitesLoading: boolean;
  siteFilterLabel: string | null;
  today: string;
  currentUserId: number | null;
  onModeChange: (mode: DashboardNoteMode) => void;
  onDraftChange: (field: keyof DashboardNoteDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onClearSiteFilter: () => void;
  onToggle: (note: DashboardNote) => void;
  onEdit: (note: DashboardNote) => void;
  onDelete: (note: DashboardNote) => void;
  onOperationalAbsenceDraftChange: (field: keyof OperationalAbsenceDraft, value: string) => void;
  onOperationalAbsenceSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const editingNote = editingNoteId === null
    ? null
    : notes.find((note) => note.id === editingNoteId) ?? null;
  const editingSite = editingNote?.site ?? null;
  const editingEmployee = editingNote?.employee ?? null;
  const editingShareUser = editingNote?.shared_with ?? null;
  const canManageShare = editingNote === null || editingNote.created_by_user_id === currentUserId;
  const siteOptions = editingSite && !sites.some((site) => site.id === editingSite.id)
    ? [...sites, editingSite].sort(compareDashboardNoteSites)
    : sites;
  const editorTextRef = useRef<HTMLTextAreaElement | null>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (editorMode === null) {
      return undefined;
    }
    const focusFrame = window.requestAnimationFrame(() => editorTextRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [editorMode]);

  return (
    <>
      <div className="dashboard-notes" id="dashboard-notes">
        <div className="dashboard-note-tabs" role="tablist" aria-label="Notizansicht">
          <button
            type="button"
            className={mode === "open" ? "is-active" : ""}
            aria-selected={mode === "open"}
            role="tab"
            onClick={() => onModeChange("open")}
          >
            Noch offen <span>{openCount}</span>
          </button>
          <button
            type="button"
            className={mode === "completed" ? "is-active" : ""}
            aria-selected={mode === "completed"}
            role="tab"
            onClick={() => onModeChange("completed")}
          >
            Erledigt <span>{completedCount}</span>
          </button>
        </div>

        {siteFilterLabel ? (
          <div className="dashboard-note-site-filter">
            <span>Baustelle: <strong>{siteFilterLabel}</strong></span>
            <button type="button" onClick={onClearSiteFilter}>Alle Notizen anzeigen</button>
          </div>
        ) : null}

        {editorMode === null && error ? <p className="dashboard-note-error">{error}</p> : null}

        {loading ? (
          <p className="dashboard-empty-text">Notizen werden geladen...</p>
        ) : notes.length > 0 ? (
          <div className="dashboard-note-list">
            {notes.map((note) => (
              <DashboardNoteRow
                busy={busyNoteId === note.id}
                key={note.id}
                note={note}
                today={today}
                canDelete={note.created_by_user_id === currentUserId}
                onDelete={onDelete}
                onEdit={onEdit}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : (
          <EmptyDashboardText text={mode === "open" ? "Keine offenen Notizen." : "Keine erledigten Notizen."} />
        )}
      </div>

      {editorMode !== null ? (
        <section
          aria-labelledby="dashboard-note-editor-title"
          className="dashboard-note-editor"
          id="dashboard-note-editor"
        >
          <header className="dashboard-note-editor-header">
            <div>
              <span>Notizen</span>
              <h3 id="dashboard-note-editor-title">
                {editorMode === "operational_absence"
                  ? "Abwesenheit erstellen"
                  : editingNoteId === null
                    ? "Notiz erstellen"
                    : "Notiz bearbeiten"}
              </h3>
            </div>
            <button aria-label="Editor schließen" type="button" onClick={onCancel}>
              <X aria-hidden="true" size={16} />
            </button>
          </header>

          {editorMode === "note" ? (
            <form className="dashboard-note-form dashboard-note-editor-form" onSubmit={onSubmit}>
              {error ? <p className="dashboard-note-error">{error}</p> : null}

              <label className="dashboard-note-field dashboard-note-field-wide">
                <span>Text</span>
                <textarea
                  ref={editorTextRef}
                  required
                  rows={5}
                  value={draft.text}
                  onChange={(event) => onDraftChange("text", event.target.value)}
                />
              </label>

              <div className="dashboard-note-form-grid dashboard-note-editor-fields">
                <label className="dashboard-note-field">
                  <span>Fällig am</span>
                  <input
                    type="date"
                    value={draft.due_date}
                    onChange={(event) => onDraftChange("due_date", event.target.value)}
                  />
                </label>
                <div className="dashboard-note-field">
                  <span id="dashboard-note-site-label">Baustelle</span>
                  <DashboardNoteSiteSelect
                    error={sitesError}
                    labelId="dashboard-note-site-label"
                    loading={sitesLoading}
                    sites={siteOptions}
                    value={draft.site_id}
                    onChange={(value) => onDraftChange("site_id", value)}
                  />
                </div>
                <div className="dashboard-note-field">
                  <span id="dashboard-note-employee-label">Monteur</span>
                  <DashboardNoteEmployeeSelect
                    error={peopleError}
                    historicalEmployee={editingEmployee}
                    labelId="dashboard-note-employee-label"
                    loading={peopleLoading}
                    people={people}
                    value={draft.employee_id}
                    onChange={(value) => onDraftChange("employee_id", value)}
                  />
                </div>
                <div className="dashboard-note-field dashboard-note-share-field">
                  <span id="dashboard-note-share-user-label">Büro anpingen</span>
                  <DashboardNoteShareUserSelect
                    disabled={!canManageShare}
                    error={shareUsersError}
                    historicalUser={editingShareUser}
                    labelId="dashboard-note-share-user-label"
                    loading={shareUsersLoading}
                    users={shareUsers}
                    value={draft.shared_with_user_id}
                    onChange={(value) => onDraftChange("shared_with_user_id", value)}
                  />
                  {!canManageShare ? (
                    <small className="dashboard-note-field-status">
                      Nur der Ersteller kann die Bürofreigabe ändern.
                    </small>
                  ) : null}
                </div>
              </div>

              <div className="dashboard-note-form-actions">
                <button type="button" className="dashboard-note-form-button" onClick={onCancel}>
                  <X aria-hidden="true" size={14} />
                  Abbrechen
                </button>
                <button type="submit" className="dashboard-note-form-button is-primary" disabled={saving}>
                  {saving ? "Speichert..." : editingNoteId === null ? "Anlegen" : "Speichern"}
                </button>
              </div>
            </form>
          ) : (
            <form
              className="dashboard-note-form dashboard-note-editor-form dashboard-operational-absence-form"
              onSubmit={onOperationalAbsenceSubmit}
            >
              {operationalAbsenceError ? (
                <p className="dashboard-note-error">{operationalAbsenceError}</p>
              ) : null}

              <label className="dashboard-note-field dashboard-note-field-wide">
                <span>Text</span>
                <textarea
                  ref={editorTextRef}
                  rows={5}
                  value={operationalAbsenceDraft.text}
                  onChange={(event) => onOperationalAbsenceDraftChange("text", event.target.value)}
                />
              </label>

              <div className="dashboard-note-form-grid dashboard-note-editor-fields">
                <label className="dashboard-note-field">
                  <span>Datum</span>
                  <input
                    required
                    type="date"
                    value={operationalAbsenceDraft.date}
                    onChange={(event) => onOperationalAbsenceDraftChange("date", event.target.value)}
                  />
                </label>
                <div className="dashboard-note-field">
                  <span id="dashboard-operational-absence-project-manager-label">Projektleiter</span>
                  <DashboardOperationalAbsenceProjectManagerSelect
                    error={operationalAbsenceProjectManagersError}
                    labelId="dashboard-operational-absence-project-manager-label"
                    loading={operationalAbsenceProjectManagersLoading}
                    people={operationalAbsenceProjectManagers}
                    value={operationalAbsenceDraft.project_manager_id}
                    onChange={(value) => onOperationalAbsenceDraftChange("project_manager_id", value)}
                  />
                </div>
                <div className="dashboard-note-field">
                  <span>Zeitraum</span>
                  <div className="dashboard-operational-absence-time-range">
                    <label>
                      <span>Von</span>
                      <input
                        aria-label="Zeitraum von"
                        type="time"
                        value={operationalAbsenceDraft.start_time}
                        onChange={(event) => onOperationalAbsenceDraftChange("start_time", event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Bis</span>
                      <input
                        aria-label="Zeitraum bis"
                        type="time"
                        value={operationalAbsenceDraft.end_time}
                        onChange={(event) => onOperationalAbsenceDraftChange("end_time", event.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="dashboard-note-field">
                  <span id="dashboard-operational-absence-site-label">Baustelle</span>
                  <DashboardNoteSiteSelect
                    error={operationalAbsenceSitesError}
                    labelId="dashboard-operational-absence-site-label"
                    loading={operationalAbsenceSitesLoading}
                    sites={operationalAbsenceSites}
                    value={operationalAbsenceDraft.site_id}
                    onChange={(value) => onOperationalAbsenceDraftChange("site_id", value)}
                  />
                </div>
              </div>

              <div className="dashboard-note-form-actions">
                <button type="button" className="dashboard-note-form-button" onClick={onCancel}>
                  <X aria-hidden="true" size={14} />
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="dashboard-note-form-button is-primary"
                  disabled={operationalAbsenceSaving}
                >
                  {operationalAbsenceSaving ? "Speichert..." : "Anlegen"}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}
    </>
  );
}

function DashboardNoteRow({
  note,
  busy,
  today,
  onToggle,
  onEdit,
  onDelete,
  canDelete,
}: {
  note: DashboardNote;
  busy: boolean;
  today: string;
  onToggle: (note: DashboardNote) => void;
  onEdit: (note: DashboardNote) => void;
  onDelete: (note: DashboardNote) => void;
  canDelete: boolean;
}) {
  const dueState = getDashboardNoteDueState(note, today);
  return (
    <article className={`dashboard-note-row${note.completed ? " is-completed" : ""}${dueState !== "none" ? ` is-${dueState}` : ""}`}>
      <button
        type="button"
        className={`dashboard-note-checkbox${note.completed ? " is-checked" : ""}`}
        aria-label={note.completed ? "Notiz wieder öffnen" : "Notiz als erledigt markieren"}
        disabled={busy}
        onClick={() => onToggle(note)}
      >
        {note.completed ? <Check aria-hidden="true" size={13} /> : null}
      </button>
      <div className="dashboard-note-body">
        <strong>{note.text}</strong>
        <div className="dashboard-note-meta">
          <span className={`dashboard-note-due is-${dueState}`}>
            {formatDashboardNoteDueLabel(note, today)}
          </span>
          {note.site ? <span>Baustelle: {formatDashboardNoteSiteOption(note.site)}</span> : null}
          {note.employee ? <span>Monteur: {note.employee.display_name}</span> : null}
          {note.shared_with ? <span>Büro: {note.shared_with.display_name}</span> : null}
        </div>
      </div>
      <div className="dashboard-note-row-actions">
        <button type="button" title="Notiz bearbeiten" aria-label="Notiz bearbeiten" disabled={busy} onClick={() => onEdit(note)}>
          <Pencil aria-hidden="true" size={14} />
        </button>
        {canDelete ? (
          <button type="button" title="Notiz löschen" aria-label="Notiz löschen" disabled={busy} onClick={() => onDelete(note)}>
            <Trash2 aria-hidden="true" size={14} />
          </button>
        ) : null}
      </div>
    </article>
  );
}

function DashboardNoteDetailModal({
  note,
  busy,
  currentUserId,
  today,
  onClose,
  onToggle,
  onEdit,
  onDelete,
}: {
  note: DashboardNote;
  busy: boolean;
  currentUserId: number | null;
  today: string;
  onClose: () => void;
  onToggle: (note: DashboardNote) => void;
  onEdit: (note: DashboardNote) => void;
  onDelete: (note: DashboardNote) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `dashboard-note-detail-title-${note.id}`;

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="matrix-notes-modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="matrix-notes-modal dashboard-note-detail-modal"
        role="dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="matrix-notes-modal-header">
          <div>
            <h2 id={titleId}>Notiz</h2>
            <p>{note.site ? formatDashboardNoteSiteOption(note.site) : "Allgemeine Notiz"}</p>
          </div>
          <button
            aria-label="Notiz schließen"
            ref={closeButtonRef}
            title="Schließen"
            type="button"
            onClick={onClose}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <div className="matrix-notes-modal-body">
          <div className="dashboard-note-list">
            <DashboardNoteRow
              busy={busy}
              canDelete={note.created_by_user_id === currentUserId}
              note={note}
              today={today}
              onDelete={onDelete}
              onEdit={onEdit}
              onToggle={onToggle}
            />
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function DashboardConflictList({ conflicts, needs }: { conflicts: DashboardConflict[]; needs: StaffingNeed[] }) {
  const visibleItems: DashboardAlertListItem[] = [
    ...groupDashboardConflicts(conflicts)
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((range) => ({ kind: "conflict" as const, range })),
    ...groupDashboardStaffingNeeds(needs)
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((range) => ({ kind: "need" as const, range })),
  ].sort(compareDashboardAlertListItems);

  if (visibleItems.length === 0) {
    return <EmptyDashboardText text="Keine harten Konflikte oder offenen Personalbedarfe im nahen Zeitraum erkannt." />;
  }

  return (
    <div className="dashboard-alert-list">
      {visibleItems.map((alert) => {
        if (alert.kind === "conflict") {
          const { item, startDate, endDate } = alert.range;
          return (
            <div className="dashboard-alert-row" key={`conflict:${item.key}:${startDate}:${endDate}`}>
              <span className="dashboard-alert-dot signal-red" aria-hidden="true" />
              <div>
                <strong>{item.title}</strong>
                <span>{formatDashboardDateRange(startDate, endDate)} · {item.detail}</span>
              </div>
            </div>
          );
        }
        const { item, startDate, endDate } = alert.range;
        return (
          <div
            className="dashboard-alert-row"
            key={`need:${item.siteNumber ?? ""}:${item.siteName}:${item.managerLabel}:${startDate}:${endDate}`}
          >
            <span className="dashboard-alert-dot signal-orange" aria-hidden="true" />
            <div>
              <strong>{formatDashboardDateRange(startDate, endDate)}: {item.siteName}</strong>
              <span>{item.managerLabel} · orange markiert, noch unbesetzt</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function groupDashboardConflicts(conflicts: DashboardConflict[]): DashboardDateRangeGroup<DashboardConflict>[] {
  return groupConsecutiveDashboardEntries(conflicts, (conflict) => [
    conflict.key.replace(/\d{4}-\d{2}-\d{2}/g, ""),
    conflict.title,
    conflict.detail,
    conflict.severity,
  ].join("\u001f"));
}

function groupDashboardStaffingNeeds(needs: StaffingNeed[]): DashboardDateRangeGroup<StaffingNeed>[] {
  return groupConsecutiveDashboardEntries(needs, (need) => [
    need.siteNumber ?? "",
    need.siteName,
    need.managerLabel,
    "orange-unassigned",
  ].join("\u001f"));
}

function groupConsecutiveDashboardEntries<T extends { date: string }>(
  entries: T[],
  getGroupKey: (entry: T) => string,
): DashboardDateRangeGroup<T>[] {
  const groups: DashboardDateRangeGroup<T>[] = [];
  const latestGroupByKey = new Map<string, DashboardDateRangeGroup<T>>();
  entries
    .slice()
    .sort((first, second) => first.date.localeCompare(second.date))
    .forEach((entry) => {
      const groupKey = getGroupKey(entry);
      const latestGroup = latestGroupByKey.get(groupKey);
      if (latestGroup && areDashboardDatesContinuous(latestGroup.endDate, entry.date)) {
        latestGroup.endDate = entry.date;
        return;
      }
      const nextGroup = {
        item: entry,
        startDate: entry.date,
        endDate: entry.date,
      };
      groups.push(nextGroup);
      latestGroupByKey.set(groupKey, nextGroup);
    });
  return groups.sort((first, second) => first.startDate.localeCompare(second.startDate));
}

function areDashboardDatesContinuous(previousDate: string, nextDate: string): boolean {
  const previousDay = isoDateToUtcDay(previousDate);
  const nextDay = isoDateToUtcDay(nextDate);
  if (previousDay === null || nextDay === null || nextDay <= previousDay) {
    return false;
  }
  for (let day = previousDay + 1; day < nextDay; day += 1) {
    const weekday = new Date(day * 86_400_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      return false;
    }
  }
  return true;
}

function isoDateToUtcDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp / 86_400_000;
}

function compareDashboardAlertListItems(first: DashboardAlertListItem, second: DashboardAlertListItem): number {
  return first.range.startDate.localeCompare(second.range.startDate)
    || first.range.endDate.localeCompare(second.range.endDate)
    || first.kind.localeCompare(second.kind);
}

function formatDashboardDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatShortDate(startDate);
  }
  return `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`;
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

function dashboardNotePayloadFromDraft(
  draft: DashboardNoteDraft,
  includeShareUser: boolean,
): DashboardNotePayload {
  const payload: DashboardNotePayload = {
    text: draft.text.trim(),
    due_date: draft.due_date || null,
    site_id: parseOptionalDashboardNoteId(draft.site_id),
    employee_id: parseOptionalDashboardNoteId(draft.employee_id),
  };
  if (includeShareUser) {
    payload.shared_with_user_id = parseOptionalDashboardNoteId(draft.shared_with_user_id);
  }
  return payload;
}

function parseOptionalDashboardNoteId(value: string): number | null {
  return value ? Number(value) : null;
}

function upsertDashboardNote(notes: DashboardNote[], note: DashboardNote): DashboardNote[] {
  const existingIndex = notes.findIndex((entry) => entry.id === note.id);
  if (existingIndex === -1) {
    return [...notes, note];
  }
  return notes.map((entry) => entry.id === note.id ? note : entry);
}

function sortDashboardNotes(notes: DashboardNote[], mode: DashboardNoteMode): DashboardNote[] {
  return notes.slice().sort((first, second) => {
    if (mode === "completed") {
      return compareNullableDateTimeDesc(first.completed_at ?? first.updated_at, second.completed_at ?? second.updated_at)
        || second.id - first.id;
    }
    if (first.due_date === null && second.due_date !== null) {
      return 1;
    }
    if (second.due_date === null && first.due_date !== null) {
      return -1;
    }
    if (first.due_date !== null && second.due_date !== null) {
      return first.due_date.localeCompare(second.due_date) || compareNullableDateTimeDesc(first.updated_at, second.updated_at);
    }
    return compareNullableDateTimeDesc(first.updated_at, second.updated_at) || second.id - first.id;
  });
}

function compareNullableDateTimeDesc(first: string | null, second: string | null): number {
  if (first === null && second !== null) {
    return 1;
  }
  if (second === null && first !== null) {
    return -1;
  }
  if (first === null || second === null) {
    return 0;
  }
  return new Date(second).getTime() - new Date(first).getTime();
}

function getDashboardNoteDueState(note: DashboardNote, today: string): "none" | "today" | "overdue" {
  if (note.completed || !note.due_date) {
    return "none";
  }
  if (note.due_date < today) {
    return "overdue";
  }
  if (note.due_date === today) {
    return "today";
  }
  return "none";
}

function formatDashboardNoteDueLabel(note: DashboardNote, today: string): string {
  if (note.completed) {
    return note.completed_at ? `Erledigt ${formatDashboardDateTime(note.completed_at)}` : "Erledigt";
  }
  if (!note.due_date) {
    return "Ohne Fälligkeitsdatum";
  }
  if (note.due_date < today) {
    return `Überfällig seit ${formatShortDate(note.due_date)}`;
  }
  if (note.due_date === today) {
    return "Heute fällig";
  }
  return `Fällig ${formatShortDate(note.due_date)}`;
}

function formatDashboardNoteSiteOption(site: SiteSummary | NonNullable<DashboardNote["site"]>): string {
  return site.site_number ? `${site.site_number} · ${site.name}` : site.name;
}

function compareDashboardNoteSites(
  first: SiteSummary | NonNullable<DashboardNote["site"]>,
  second: SiteSummary | NonNullable<DashboardNote["site"]>,
): number {
  return compareSiteNumbers(first.site_number, second.site_number)
    || first.name.localeCompare(second.name, "de", { sensitivity: "base" })
    || first.id - second.id;
}

function compareDashboardNotePeople(first: Person, second: Person): number {
  return first.last_name.localeCompare(second.last_name, "de", { sensitivity: "base" })
    || first.first_name.localeCompare(second.first_name, "de", { sensitivity: "base" })
    || first.display_name.localeCompare(second.display_name, "de", { sensitivity: "base" })
    || first.id - second.id;
}

function isAssignableDashboardNotePerson(person: Person): boolean {
  if (!person.is_active || person.deleted_at !== null) {
    return false;
  }
  if (person.person_type !== "internal") {
    return true;
  }
  const activeUserRoles = person.user_roles ?? [];
  return activeUserRoles.length === 0 || activeUserRoles.includes("monteur");
}

function parseDashboardNoteSiteFilterId(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const siteId = Number(value);
  return Number.isSafeInteger(siteId) && siteId > 0 ? siteId : null;
}

function formatSiteTileMeta(siteSummary: AssignedSiteSummary): string {
  const workerCount = siteSummary.internalCount + siteSummary.externalCount;
  const workerLabel = formatCount(workerCount, "Monteur", "Monteure");
  return siteSummary.site.site_number ? `${workerLabel} · ${siteSummary.site.site_number}` : workerLabel;
}

function dashboardMessagesSignature(messages: DashboardMessage[]): string {
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
      message.note_id,
      message.note_preview,
      message.note_due_date,
      message.note_created_at,
      message.message_text,
      message.tool_id,
      message.tool_issue_report_id,
    ].join("|"))
    .join(";");
}

function formatDashboardMessageTitle(message: DashboardMessage): string {
  if (message.message_type === "dashboard_note_shared" || message.message_type === "tool_issue_reported") {
    return message.title;
  }
  if (message.message_type === "measurement_customer_signed") {
    return `${message.title} für ${message.site_name} wurde vom Kunden unterschrieben. Bitte prüfen.`;
  }
  return `${message.title} für ${message.site_name} wurde zur Prüfung eingereicht.`;
}

function getDashboardMessageLink(message: DashboardMessage): string {
  if (message.site_id === null) {
    return "/";
  }
  if (message.message_type === "extra_work_submitted") {
    return `/sites/${message.site_id}?tab=extra-work`;
  }
  return `/sites/${message.site_id}?tab=measurement&measurementSubtab=review`;
}

function getDashboardMessageMetaItems(message: DashboardMessage): DashboardMessageMetaItem[] {
  if (message.message_type === "tool_issue_reported") {
    const eventAt = message.event_at ?? message.submitted_at;
    return [
      { key: "time", label: eventAt ? formatDashboardDateTime(eventAt) : "Zeitpunkt unbekannt" },
      { key: "reporter", label: message.submitted_by_name ?? "Monteur" },
    ];
  }
  if (message.message_type === "dashboard_note_shared") {
    const createdAt = message.note_created_at ?? message.submitted_at;
    const items: DashboardMessageMetaItem[] = [{
      key: "created",
      label: createdAt ? `Erstellt ${formatDashboardDateTime(createdAt)}` : "Erstellungszeit unbekannt",
    }];
    if (message.note_due_date) {
      items.push({ key: "due", label: `Fällig ${formatShortDate(message.note_due_date)}` });
    }
    items.push({
      key: "site",
      label: message.site_name
        ? `Baustelle ${message.site_number ? `${message.site_number} · ` : ""}${message.site_name}`
        : "Allgemeine Notiz",
    });
    return items;
  }
  const eventAt = message.event_at ?? message.customer_signed_at ?? message.submitted_at;
  const timeLabel = eventAt ? formatDashboardDateTime(eventAt) : "Zeitpunkt unbekannt";
  const items: DashboardMessageMetaItem[] = [{ key: "time", label: timeLabel }];

  if (message.message_type === "measurement_customer_signed") {
    const signerLabel = message.customer_signature_name
      ? `Unterschrieben von ${message.customer_signature_name}`
      : "Kundenunterschrift";
    items.push({ key: "context", label: signerLabel });
  } else if (message.submitted_by_name) {
    items.push({ key: "context", label: message.submitted_by_name });
  }

  if (message.site_number) {
    items.push({ key: "site", label: message.site_number });
  }

  return items;
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
    short_code: calendarPersonCode(person),
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
  return normalizeShortCode(calendarPersonCode(manager) || manager.display_name);
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

function formatDashboardGreeting(name: string): string {
  const cleanedName = name.trim();
  return cleanedName ? `Hallo ${cleanedName}` : "Hallo";
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(parseDateKey(value));
}
