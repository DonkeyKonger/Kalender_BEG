import {
  CalendarClock,
  ChevronRight,
  FileText,
  FolderOpen,
  HeartPulse,
  LogOut,
  MapPin,
  Plane,
  RefreshCcw,
  Settings,
  UserCircle,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent as ReactUIEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { MobileBackButton } from "../components/MobileBackButton";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
import { buildMobileAssignmentHistoryWeeks } from "../lib/mobileAssignmentHistory";
import {
  ANDROID_GPS_PING_INTERVAL_MS,
  checkAndroidGpsPermissions,
  formatMobileGpsError,
  getAndroidBackgroundGpsStatus,
  getMobileGpsPlatform,
  openAndroidAppLocationSettings,
  isAndroidAppContext,
  requestForegroundLocationPermission,
  startAndroidBackgroundGpsTracking,
  stopAndroidBackgroundGpsTracking,
} from "../lib/mobileGps";
import { useMobileScrollReset } from "../lib/mobileScroll";
import { canUsePushNotifications, initializePushNotifications } from "../lib/pushNotifications";
import { useMobileModalStack } from "../lib/useMobileModalStack";
import type { AndroidBackgroundGpsStatus, AndroidGpsPermissionStatus } from "../lib/mobileGps";
import type {
  MobileAssignment,
  MobileAssignmentSiteHistoryResponse,
  MobileAssignmentSiteSummary,
  MobileAssignmentsResponse,
  MobileSite,
} from "../types/mobile";

const CACHE_KEY_PREFIX = "kb_mobile_assignments_cache_v3";
const GPS_TRACKING_ENABLED_KEY = "kb_mobile_gps_tracking_enabled_v1";
const PUSH_NOTIFICATIONS_ENABLED_KEY = "kb_mobile_push_notifications_enabled_v1";
const MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE = 2;

type CachePayload = {
  loadedAt: string;
  data: MobileAssignmentsResponse;
};

type DailyAssignment = {
  key: string;
  date: string;
  assignment: MobileAssignment;
};

type MobileHomeTimelineItem = {
  key: string;
  start: string;
  end: string;
  dayCount: number;
  assignment: MobileAssignment | null;
  order: number;
};

type PlaceholderContent = {
  title: string;
  text: string;
};

type SelfPlanSheetState = {
  workDate: string;
  label: string;
};

export function MyAssignmentsPage() {
  const navigate = useNavigate();
  const { logout, status, user } = useAuth();
  const [data, setData] = useState<MobileAssignmentsResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState<PlaceholderContent | null>(null);
  const [selfPlanSheet, setSelfPlanSheet] = useState<SelfPlanSheetState | null>(null);
  const [recentSelfPlanSites, setRecentSelfPlanSites] = useState<MobileSite[] | null>(null);
  const [isLoadingSelfPlanSites, setIsLoadingSelfPlanSites] = useState(false);
  const [selfPlanError, setSelfPlanError] = useState<string | null>(null);
  const [selfPlanningSiteId, setSelfPlanningSiteId] = useState<number | null>(null);
  const [activeScreen, setActiveScreen] = useState<"home" | "assignments" | "settings">("home");
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const [gpsMessageTone, setGpsMessageTone] = useState<"info" | "error">("info");
  const [lastAutomaticGpsSentAt, setLastAutomaticGpsSentAt] = useState<string | null>(null);
  const [androidGpsStatus, setAndroidGpsStatus] = useState<AndroidBackgroundGpsStatus | null>(null);
  const [androidGpsPermissions, setAndroidGpsPermissions] = useState<AndroidGpsPermissionStatus | null>(null);
  const [isHandlingGpsPermission, setIsHandlingGpsPermission] = useState(false);
  const [isTogglingGpsTracking, setIsTogglingGpsTracking] = useState(false);
  const [isGpsTrackingEnabled, setIsGpsTrackingEnabled] = useState(() => readGpsTrackingPreference());
  const [isPushNotificationsEnabled, setIsPushNotificationsEnabled] = useState(() => readPushNotificationPreference());
  const [isTogglingPushNotifications, setIsTogglingPushNotifications] = useState(false);
  const [pushNotificationMessage, setPushNotificationMessage] = useState<string | null>(null);
  const [pushNotificationMessageTone, setPushNotificationMessageTone] = useState<"info" | "error">("info");
  const [activeHomeTimelineIndex, setActiveHomeTimelineIndex] = useState(0);
  const [assignmentSites, setAssignmentSites] = useState<MobileAssignmentSiteSummary[]>([]);
  const [assignmentSitesLoaded, setAssignmentSitesLoaded] = useState(false);
  const [assignmentSitesLoading, setAssignmentSitesLoading] = useState(false);
  const [assignmentSitesError, setAssignmentSitesError] = useState<string | null>(null);
  const [selectedAssignmentSite, setSelectedAssignmentSite] = useState<MobileAssignmentSiteSummary | null>(null);
  const [assignmentSiteHistory, setAssignmentSiteHistory] = useState<MobileAssignmentSiteHistoryResponse | null>(null);
  const [assignmentSiteHistoryLoading, setAssignmentSiteHistoryLoading] = useState(false);
  const [assignmentSiteHistoryError, setAssignmentSiteHistoryError] = useState<string | null>(null);
  const assignmentLoadRequestIdRef = useRef(0);
  const assignmentSiteHistoryRequestIdRef = useRef(0);
  const mobileHomeTimelineRef = useRef<HTMLDivElement | null>(null);

  const range = useMemo(() => getUpcomingRange(), []);
  const assignmentCacheKey = useMemo(
    () => getAssignmentsCacheKey(user?.id ?? null),
    [user?.id],
  );

  const loadAssignments = useCallback(async () => {
    const requestId = ++assignmentLoadRequestIdRef.current;
    setIsLoading(true);
    setError(null);
    setIsFromCache(false);
    try {
      const response = await api.myAssignments(range);
      if (requestId !== assignmentLoadRequestIdRef.current) {
        return;
      }
      const timestamp = new Date().toISOString();
      const cachePayload: CachePayload = { loadedAt: timestamp, data: response };
      writeCache(assignmentCacheKey, cachePayload);
      setData(response);
      setLoadedAt(timestamp);
    } catch (requestError) {
      if (requestId !== assignmentLoadRequestIdRef.current) {
        return;
      }
      const cached = readCache(assignmentCacheKey);
      if (cached) {
        setData(cached.data);
        setLoadedAt(cached.loadedAt);
        setIsFromCache(true);
        setError("Offline-Anzeige: zuletzt geladene Einsätze werden angezeigt.");
      } else {
        setData(null);
        setLoadedAt(null);
        setError(readApiError(requestError, "Einsätze konnten nicht geladen werden."));
      }
    } finally {
      if (requestId === assignmentLoadRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [assignmentCacheKey, range]);

  useEffect(() => {
    void loadAssignments();
    return () => {
      assignmentLoadRequestIdRef.current += 1;
    };
  }, [loadAssignments]);

  const loadAssignmentSites = useCallback(async () => {
    setAssignmentSitesLoading(true);
    setAssignmentSitesError(null);
    try {
      const response = await api.myAssignmentSites();
      setAssignmentSites(response.sites);
      setAssignmentSitesLoaded(true);
    } catch (requestError) {
      setAssignmentSitesError(readApiError(requestError, "Einsatzhistorie konnte nicht geladen werden."));
      setAssignmentSitesLoaded(true);
    } finally {
      setAssignmentSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeScreen === "assignments") {
      void loadAssignmentSites();
    }
  }, [activeScreen, loadAssignmentSites]);

  const refreshAndroidGpsStatus = useCallback(async () => {
    if (!isAndroidAppContext()) {
      setAndroidGpsStatus(null);
      setLastAutomaticGpsSentAt(null);
      return;
    }
    try {
      const trackingStatus = await getAndroidBackgroundGpsStatus();
      setAndroidGpsStatus(trackingStatus);
      if (trackingStatus.lastSentAt) {
        setLastAutomaticGpsSentAt(trackingStatus.lastSentAt);
      }
      if (trackingStatus.lastError) {
        setGpsMessage(trackingStatus.lastError);
        setGpsMessageTone("error");
      }
    } catch (statusError) {
      setGpsMessage(formatMobileGpsError(statusError));
      setGpsMessageTone("error");
    }
  }, []);

  const syncAndroidGpsTracking = useCallback(async () => {
    if (status !== "authenticated" || user?.role !== "monteur" || !isAndroidAppContext()) {
      setAndroidGpsPermissions(null);
      setAndroidGpsStatus(null);
      void stopAndroidBackgroundGpsTracking();
      return;
    }

    try {
      if (!isGpsTrackingEnabled) {
        const stoppedStatus = await stopAndroidBackgroundGpsTracking();
        setAndroidGpsStatus(stoppedStatus);
        return;
      }

      const permissions = await checkAndroidGpsPermissions();
      setAndroidGpsPermissions(permissions);
      if (!hasRequiredAndroidGpsPermissions(permissions)) {
        const stoppedStatus = await stopAndroidBackgroundGpsTracking();
        setAndroidGpsStatus(stoppedStatus);
        return;
      }

      const trackingStatus = await startAndroidBackgroundGpsTracking();
      setAndroidGpsStatus(trackingStatus);
      if (trackingStatus.lastSentAt) {
        setLastAutomaticGpsSentAt(trackingStatus.lastSentAt);
      }
      if (trackingStatus.isTracking) {
        setGpsMessage("Android-Hintergrundstandort aktiv.");
        setGpsMessageTone("info");
      }
    } catch (trackingError) {
      setGpsMessage(formatMobileGpsError(trackingError));
      setGpsMessageTone("error");
      await refreshAndroidGpsStatus();
    }
  }, [isGpsTrackingEnabled, refreshAndroidGpsStatus, status, user?.role]);

  useEffect(() => {
    void syncAndroidGpsTracking();
  }, [syncAndroidGpsTracking]);

  useEffect(() => {
    if (!isPushNotificationsEnabled || status !== "authenticated" || !user) {
      return;
    }
    void initializePushNotifications(user).catch((pushError) => {
      console.warn("Push notification initialization failed", pushError);
    });
  }, [isPushNotificationsEnabled, status, user]);

  useEffect(() => {
    if (status !== "authenticated" || user?.role !== "monteur" || !isAndroidAppContext()) {
      return undefined;
    }

    const handleResume = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void syncAndroidGpsTracking();
    };
    window.addEventListener("focus", handleResume);
    document.addEventListener("visibilitychange", handleResume);

    return () => {
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [status, syncAndroidGpsTracking, user?.role]);

  useEffect(() => {
    if (status !== "authenticated" || user?.role !== "monteur" || !isAndroidAppContext()) {
      return undefined;
    }

    void refreshAndroidGpsStatus();
    const statusTimer = window.setInterval(() => {
      void refreshAndroidGpsStatus();
    }, 30_000);

    return () => {
      window.clearInterval(statusTimer);
    };
  }, [refreshAndroidGpsStatus, status, user?.role]);

  async function handleGpsTrackingToggle(nextEnabled: boolean): Promise<void> {
    if (isTogglingGpsTracking) {
      return;
    }

    setIsTogglingGpsTracking(true);
    setGpsMessageTone("info");
    setGpsMessage(nextEnabled ? "Ortung wird aktiviert ..." : "Ortung wird ausgeschaltet ...");
    setIsGpsTrackingEnabled(nextEnabled);
    writeGpsTrackingPreference(nextEnabled);

    try {
      if (!nextEnabled) {
        const stoppedStatus = await stopAndroidBackgroundGpsTracking();
        setAndroidGpsStatus(stoppedStatus);
        setGpsMessage("Ortung ausgeschaltet.");
        setGpsMessageTone("info");
        return;
      }

      if (status !== "authenticated" || user?.role !== "monteur" || !isAndroidAppContext()) {
        setGpsMessage("Ortung ist nur in der Android-App verfügbar.");
        setGpsMessageTone("error");
        return;
      }

      const permissions = await checkAndroidGpsPermissions();
      setAndroidGpsPermissions(permissions);
      if (!hasRequiredAndroidGpsPermissions(permissions)) {
        const stoppedStatus = await stopAndroidBackgroundGpsTracking();
        setAndroidGpsStatus(stoppedStatus);
        setGpsMessage("Für die Ortung fehlen noch Berechtigungen.");
        setGpsMessageTone("error");
        return;
      }

      const trackingStatus = await startAndroidBackgroundGpsTracking();
      setAndroidGpsStatus(trackingStatus);
      if (trackingStatus.lastSentAt) {
        setLastAutomaticGpsSentAt(trackingStatus.lastSentAt);
      }
      setGpsMessage(trackingStatus.isTracking ? "Ortung aktiv." : "Ortung konnte nicht aktiviert werden.");
      setGpsMessageTone("info");
    } catch (requestError) {
      setGpsMessage(formatMobileGpsError(requestError));
      setGpsMessageTone("error");
    } finally {
      setIsTogglingGpsTracking(false);
    }
  }

  async function handlePushNotificationsToggle(nextEnabled: boolean): Promise<void> {
    if (isTogglingPushNotifications) {
      return;
    }

    setIsTogglingPushNotifications(true);
    setPushNotificationMessageTone("info");
    setPushNotificationMessage(nextEnabled ? "Benachrichtigungen werden aktiviert ..." : "Benachrichtigungen ausgeschaltet.");
    setIsPushNotificationsEnabled(nextEnabled);
    writePushNotificationPreference(nextEnabled);

    try {
      if (!nextEnabled) {
        setPushNotificationMessage("Benachrichtigungen für dieses Gerät ausgeschaltet.");
        return;
      }
      if (status !== "authenticated" || !user || !canUsePushNotifications()) {
        setPushNotificationMessage("Benachrichtigungen sind nur in der Android-App verfügbar.");
        setPushNotificationMessageTone("error");
        setIsPushNotificationsEnabled(false);
        writePushNotificationPreference(false);
        return;
      }

      const registered = await initializePushNotifications(user);
      if (!registered) {
        setPushNotificationMessage("Benachrichtigungen wurden nicht erlaubt.");
        setPushNotificationMessageTone("error");
        setIsPushNotificationsEnabled(false);
        writePushNotificationPreference(false);
        return;
      }
      setPushNotificationMessage("Benachrichtigungen ein.");
      setPushNotificationMessageTone("info");
    } catch (pushError) {
      console.warn("Push notification toggle failed", pushError);
      setPushNotificationMessage("Benachrichtigungen konnten nicht aktiviert werden.");
      setPushNotificationMessageTone("error");
      setIsPushNotificationsEnabled(false);
      writePushNotificationPreference(false);
    } finally {
      setIsTogglingPushNotifications(false);
    }
  }

  async function handleAndroidGpsPermissionAction(): Promise<void> {
    const prompt = getAndroidGpsPermissionPrompt(androidGpsPermissions);
    if (!prompt || isHandlingGpsPermission) {
      return;
    }

    setIsHandlingGpsPermission(true);
    setGpsMessageTone("info");
    try {
      if (prompt.kind === "background") {
        setGpsMessage("App-Einstellungen geöffnet. Bitte Standort auf Immer erlauben stellen.");
        await openAndroidAppLocationSettings();
      } else {
        setGpsMessage("Android-Berechtigung wird angefragt ...");
        const permissions = await requestForegroundLocationPermission();
        setAndroidGpsPermissions(permissions);
        if (hasRequiredAndroidGpsPermissions(permissions)) {
          await syncAndroidGpsTracking();
        } else {
          setGpsMessage("Standortberechtigung ist noch nicht vollständig erteilt.");
        }
      }
      setGpsMessageTone("info");
    } catch (permissionError) {
      setGpsMessage(formatMobileGpsError(permissionError));
      setGpsMessageTone("error");
    } finally {
      setIsHandlingGpsPermission(false);
    }
  }

  async function handleLogout(): Promise<void> {
    await stopAndroidBackgroundGpsTracking();
    await logout();
  }

  async function openAssignmentSite(summary: MobileAssignmentSiteSummary): Promise<void> {
    const requestId = ++assignmentSiteHistoryRequestIdRef.current;
    setSelectedAssignmentSite(summary);
    setAssignmentSiteHistory(null);
    setAssignmentSiteHistoryError(null);
    setAssignmentSiteHistoryLoading(true);
    try {
      const response = await api.myAssignmentSiteHistory(summary.site.id);
      if (requestId === assignmentSiteHistoryRequestIdRef.current) {
        setAssignmentSiteHistory(response);
      }
    } catch (requestError) {
      if (requestId === assignmentSiteHistoryRequestIdRef.current) {
        setAssignmentSiteHistoryError(readApiError(requestError, "Einsatzhistorie konnte nicht geladen werden."));
      }
    } finally {
      if (requestId === assignmentSiteHistoryRequestIdRef.current) {
        setAssignmentSiteHistoryLoading(false);
      }
    }
  }

  function closeAssignmentSiteHistory(): void {
    assignmentSiteHistoryRequestIdRef.current += 1;
    setSelectedAssignmentSite(null);
    setAssignmentSiteHistory(null);
    setAssignmentSiteHistoryError(null);
    setAssignmentSiteHistoryLoading(false);
  }

  async function openSelfPlanSheet(workDate: string, label: string): Promise<void> {
    setSelfPlanSheet({ workDate, label });
    setSelfPlanError(null);
    if (recentSelfPlanSites !== null || isLoadingSelfPlanSites) {
      return;
    }

    setIsLoadingSelfPlanSites(true);
    try {
      const sites = await api.recentlyPlannedSites({ months: 6 });
      setRecentSelfPlanSites(sites);
    } catch (requestError) {
      setSelfPlanError(readApiError(requestError, "Baustellen konnten nicht geladen werden."));
    } finally {
      setIsLoadingSelfPlanSites(false);
    }
  }

  async function handleSelfPlanSite(site: MobileSite): Promise<void> {
    if (!selfPlanSheet || selfPlanningSiteId !== null) {
      return;
    }

    setSelfPlanningSiteId(site.id);
    setSelfPlanError(null);
    try {
      const assignment = await api.selfPlanAssignment({
        siteId: site.id,
        workDate: selfPlanSheet.workDate,
      });
      const timestamp = new Date().toISOString();
      setData((current) => {
        const nextData = upsertMobileAssignment(
          current ?? { start_date: range.start, end_date: range.end, assignments: [] },
          assignment,
        );
        writeCache(assignmentCacheKey, { loadedAt: timestamp, data: nextData });
        return nextData;
      });
      setAssignmentSites([]);
      setAssignmentSitesLoaded(false);
      setLoadedAt(timestamp);
      setIsFromCache(false);
      setSelfPlanSheet(null);
    } catch (requestError) {
      setSelfPlanError(readApiError(requestError, "Einsatz konnte nicht nachgetragen werden."));
    } finally {
      setSelfPlanningSiteId(null);
    }
  }

  const today = toIsoDate(startOfToday());
  const dailyAssignments = useMemo(
    () => expandAssignmentsByDay(data?.assignments ?? [], range.start, range.end),
    [data?.assignments, range.end, range.start],
  );
  const nextFourteenDays = useMemo(() => getDayRange(today, 14), [today]);
  const dailyByDate = useMemo(() => groupDailyAssignments(dailyAssignments), [dailyAssignments]);
  const mobileHomeDays = useMemo(
    () => nextFourteenDays
      .filter((date) => shouldShowMobileUpcomingDay(date, dailyByDate.get(date) ?? [])),
    [dailyByDate, nextFourteenDays],
  );
  const mobileHomeTimelineItems = useMemo(
    () => buildMobileHomeTimelineItems(mobileHomeDays, dailyByDate),
    [dailyByDate, mobileHomeDays],
  );
  const mobileHomeTimelinePages = useMemo(
    () => chunkMobileHomeTimelineItems(mobileHomeTimelineItems),
    [mobileHomeTimelineItems],
  );
  const mobileHomePlannedCount = useMemo(
    () => mobileHomeTimelineItems.filter((item) => item.assignment !== null).length,
    [mobileHomeTimelineItems],
  );
  const androidGpsPermissionPrompt = getAndroidGpsPermissionPrompt(androidGpsPermissions);
  const mobileGpsPlatform = getMobileGpsPlatform();
  const showGpsDebug = import.meta.env.DEV;
  const showGpsDebugStatus = showGpsDebug && user?.role === "monteur";
  const canUseAndroidGpsTracking = user?.role === "monteur" && isAndroidAppContext();
  const gpsToggleLabel = isGpsTrackingEnabled ? "Ortung aktiv" : "Ortung aus";
  const canUseAppPushNotifications = canUsePushNotifications();
  const pushToggleLabel = isPushNotificationsEnabled ? "Benachrichtigungen ein" : "Benachrichtigungen aus";
  useMobileScrollReset(
    `${activeScreen}:${selectedAssignmentSite?.site.id ?? "list"}`,
    activeScreen !== "home",
  );

  useEffect(() => {
    setActiveHomeTimelineIndex(0);
    if (mobileHomeTimelineRef.current) {
      mobileHomeTimelineRef.current.scrollLeft = 0;
    }
  }, [mobileHomeTimelinePages]);

  const handleMobileHomeTimelineScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const timeline = event.currentTarget;
    const items = Array.from(
      timeline.querySelectorAll<HTMLElement>("[data-mobile-home-timeline-page]"),
    );
    if (!items.length) {
      return;
    }
    const closestIndex = items.reduce((bestIndex, item, index) => (
      Math.abs(item.offsetLeft - timeline.scrollLeft)
        < Math.abs(items[bestIndex].offsetLeft - timeline.scrollLeft)
        ? index
        : bestIndex
    ), 0);
    setActiveHomeTimelineIndex((current) => current === closestIndex ? current : closestIndex);
  }, []);

  const scrollMobileHomeTimelineTo = useCallback((index: number) => {
    const timeline = mobileHomeTimelineRef.current;
    const item = timeline?.querySelectorAll<HTMLElement>("[data-mobile-home-timeline-page]").item(index);
    if (!timeline || !item) {
      return;
    }
    timeline.scrollTo({ left: item.offsetLeft, behavior: "smooth" });
  }, []);

  if (activeScreen === "assignments") {
    if (selectedAssignmentSite) {
      return (
        <MobileAssignmentSiteHistory
          error={assignmentSiteHistoryError}
          history={assignmentSiteHistory}
          isLoading={assignmentSiteHistoryLoading}
          summary={selectedAssignmentSite}
          onBack={closeAssignmentSiteHistory}
          onOpenProjectFile={(assignment) => navigate(`/me/assignments/${assignment.id}`, {
            state: { assignment },
          })}
          onRetry={() => void openAssignmentSite(selectedAssignmentSite)}
        />
      );
    }

    return (
      <section className="mobile-page mobile-home-page mobile-assignment-history-page">
        <header className="mobile-assignment-history-header">
          <MobileBackButton label="Zurück zu Meine Übersicht" onClick={() => setActiveScreen("home")} />
          <div>
            <h1>Meine Einsätze</h1>
            <p>Alle Einsätze chronologisch</p>
          </div>
        </header>

        {assignmentSitesError ? (
          <MobileAssignmentHistoryState
            actionLabel="Erneut versuchen"
            message={assignmentSitesError}
            tone="error"
            onAction={() => void loadAssignmentSites()}
          />
        ) : null}
        {assignmentSitesLoading ? (
          <MobileAssignmentHistoryState message="Einsätze werden geladen ..." />
        ) : null}
        {!assignmentSitesLoading && !assignmentSitesError && assignmentSitesLoaded && !assignmentSites.length ? (
          <MobileAssignmentHistoryState message="Noch keine Einsätze vorhanden." />
        ) : null}
        {!assignmentSitesLoading && !assignmentSitesError && assignmentSites.length ? (
          <div className="mobile-assignment-site-list">
            {assignmentSites.map((summary) => (
              <MobileAssignmentSiteCard
                key={summary.site.id}
                summary={summary}
                onOpen={() => void openAssignmentSite(summary)}
              />
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  if (activeScreen === "settings") {
    return (
      <section className="mobile-page mobile-home-page">
        <MobileBackButton label="Zurück zu Meine Übersicht" onClick={() => setActiveScreen("home")} />

        <header className="mobile-subpage-title">
          <p className="eyebrow">Optionen</p>
          <h1>Einstellungen</h1>
        </header>

        <div className="mobile-settings-list">
          <section className="mobile-location-settings-card" aria-label="Standortprüfung">
            <div className="mobile-location-settings-head">
              <div>
                <h2>Standortprüfung</h2>
                <p>{gpsToggleLabel}</p>
              </div>
              <label className="mobile-toggle">
                <input
                  checked={isGpsTrackingEnabled}
                  disabled={!canUseAndroidGpsTracking || isTogglingGpsTracking}
                  type="checkbox"
                  onChange={(event) => void handleGpsTrackingToggle(event.target.checked)}
                />
                <span aria-hidden="true" />
              </label>
            </div>
            <p className="mobile-location-settings-text">
              Standortdaten helfen dem Büro später zu prüfen, ob gemeldete Baustellenzeiten plausibel zur geplanten Baustelle passen. Es geht nicht um Live-Überwachung.
            </p>
            {canUseAndroidGpsTracking && isGpsTrackingEnabled && androidGpsPermissionPrompt ? (
              <div className="form-info mobile-gps-status">
                <strong>{androidGpsPermissionPrompt.title}</strong>
                <p>{androidGpsPermissionPrompt.text}</p>
                <button
                  className="icon-button secondary"
                  disabled={isHandlingGpsPermission}
                  type="button"
                  onClick={() => void handleAndroidGpsPermissionAction()}
                >
                  <MapPin aria-hidden="true" size={17} />
                  <span>{isHandlingGpsPermission ? "Bitte warten ..." : androidGpsPermissionPrompt.actionLabel}</span>
                </button>
              </div>
            ) : null}
            {!canUseAndroidGpsTracking ? <p className="cache-note mobile-gps-status">Ortung ist nur in der Android-App verfügbar.</p> : null}
            {gpsMessage ? <p className={gpsMessageTone === "error" ? "form-error mobile-gps-status" : "form-info mobile-gps-status"}>{gpsMessage}</p> : null}
            {showGpsDebugStatus && isAndroidAppContext() ? (
              <>
                <p className="cache-note mobile-gps-status">
                  Android-Hintergrundstandort: alle {Math.round(ANDROID_GPS_PING_INTERVAL_MS / 60_000)} Minuten, wenn in der App aktiviert.
                </p>
                {lastAutomaticGpsSentAt ? <p className="cache-note mobile-gps-status">Zuletzt automatisch gesendet: {formatDateTime(lastAutomaticGpsSentAt)}</p> : null}
              </>
            ) : null}
            {showGpsDebugStatus ? (
              <MobileGpsDebugCard
                platform={mobileGpsPlatform}
                permissions={androidGpsPermissions}
                status={androidGpsStatus}
                lastAutomaticSentAt={lastAutomaticGpsSentAt}
              />
            ) : null}
          </section>

          <section className="mobile-location-settings-card" aria-label="Benachrichtigungen">
            <div className="mobile-location-settings-head">
              <div>
                <h2>Benachrichtigungen</h2>
                <p>{pushToggleLabel}</p>
              </div>
              <label className="mobile-toggle">
                <input
                  checked={isPushNotificationsEnabled}
                  disabled={!canUseAppPushNotifications || isTogglingPushNotifications}
                  type="checkbox"
                  onChange={(event) => void handlePushNotificationsToggle(event.target.checked)}
                />
                <span aria-hidden="true" />
              </label>
            </div>
            <p className="mobile-location-settings-text">
              Hinweise zu geänderten Einsätzen und geprüften Aufmaßen erhalten.
            </p>
            {!canUseAppPushNotifications ? <p className="cache-note mobile-gps-status">Benachrichtigungen sind nur in der Android-App verfügbar.</p> : null}
            {pushNotificationMessage ? (
              <p className={pushNotificationMessageTone === "error" ? "form-error mobile-gps-status" : "form-info mobile-gps-status"}>
                {pushNotificationMessage}
              </p>
            ) : null}
          </section>

          <section className="mobile-settings-system-actions" aria-label="Daten und Konto">
            <button
              className="mobile-settings-system-action"
              disabled={isLoading}
              type="button"
              onClick={() => void loadAssignments()}
            >
              <RefreshCcw aria-hidden="true" size={18} />
              <span>
                <strong>{isLoading ? "Daten werden aktualisiert ..." : "Daten aktualisieren"}</strong>
                <small>Einsatzdaten erneut laden</small>
              </span>
              <ChevronRight aria-hidden="true" size={18} />
            </button>
            <button
              className="mobile-settings-system-action"
              type="button"
              onClick={() => void handleLogout()}
            >
              <LogOut aria-hidden="true" size={18} />
              <span>
                <strong>Abmelden</strong>
                <small>Aktuelle Sitzung beenden</small>
              </span>
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          </section>
        </div>
      </section>
    );
  }

  return (
    <section className="mobile-page mobile-home-page">
      <header className="mobile-home-overview-header">
        <div className="mobile-home-identity-row">
          <span className="mobile-home-user-icon" aria-hidden="true">
            <UserRound size={16} />
          </span>
          <strong>{user?.display_name || "Mitarbeiter"}</strong>
          <span className={isFromCache ? "mobile-home-status-badge is-cache" : "mobile-home-status-badge"}>
            {isFromCache ? "Offline" : "Online"}
          </span>
        </div>

        <div className="mobile-home-title-copy">
          <h1>Meine Übersicht</h1>
          <div className="mobile-home-meta-row">
            <span>
              <CalendarClock aria-hidden="true" size={14} />
              {formatHomeOverviewDate(today)}
            </span>
            {loadedAt ? <span>Aktualisiert {formatTime(loadedAt)}</span> : null}
          </div>
        </div>

      </header>

      {error && <p className={isFromCache ? "form-info" : "form-error"}>{error}</p>}
      {isLoading && <div className="empty-panel">Einsätze werden geladen...</div>}

      {!isLoading && (
        <>
          <section className="mobile-home-overview-panel" aria-labelledby="mobile-home-assignments-title">
            <div className="mobile-home-timeline-heading">
              <h2 id="mobile-home-assignments-title">Nächste Einsätze</h2>
              <span>{mobileHomePlannedCount} geplant</span>
            </div>
            <div
              aria-label="Nächste Einsätze als wischbare Timeline"
              className="mobile-home-timeline-track"
              ref={mobileHomeTimelineRef}
              role="region"
              onScroll={handleMobileHomeTimelineScroll}
            >
              {mobileHomeTimelinePages.map((page) => (
                <div
                  className="mobile-home-timeline-page"
                  data-mobile-home-timeline-page
                  key={page.map((item) => item.key).join(":")}
                >
                  {page.map((item) => (
                    <MobileHomeTimelineCard
                      isNext={item.key === mobileHomeTimelineItems[0]?.key}
                      item={item}
                      key={item.key}
                      today={today}
                      onEmptyDaySelect={(workDate, label) => void openSelfPlanSheet(workDate, label)}
                    />
                  ))}
                </div>
              ))}
            </div>
            {mobileHomeTimelinePages.length > 1 ? (
              <div className="mobile-home-timeline-pagination" aria-label="Position in der Einsatz-Timeline">
                {mobileHomeTimelinePages.map((page, index) => (
                  <button
                    aria-current={activeHomeTimelineIndex === index ? "true" : undefined}
                    aria-label={`Einsatzgruppe ${index + 1} von ${mobileHomeTimelinePages.length} anzeigen`}
                    className={activeHomeTimelineIndex === index ? "is-active" : ""}
                    key={page.map((item) => item.key).join(":")}
                    type="button"
                    onClick={() => scrollMobileHomeTimelineTo(index)}
                  />
                ))}
                <span aria-live="polite">
                  {activeHomeTimelineIndex + 1} / {mobileHomeTimelinePages.length}
                </span>
              </div>
            ) : null}
            <button
              className="mobile-home-all-assignments-button"
              title="Alle Einsätze anzeigen"
              type="button"
              onClick={() => setActiveScreen("assignments")}
            >
              <span>Alle Einsätze anzeigen</span>
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          </section>

          <section className="mobile-home-section">
            <div className="mobile-action-list mobile-home-quick-actions">
              <PlaceholderAction
                compact
                icon={FileText}
                tone="time"
                title="Arbeitszeit erfassen"
                text="Arbeitszeit tagesbezogen eintragen oder ändern."
                onOpen={() => navigate("/me/time-entry")}
              />
              <PlaceholderAction
                compact
                icon={UserCircle}
                tone="profile"
                title="Persönliche Akte"
                text="Urlaub, Kranktage, Fahrzeug und Werkzeuge anzeigen."
                onOpen={() => navigate("/me/personal-file")}
              />
              <PlaceholderAction
                compact
                icon={Plane}
                tone="vacation"
                title="Urlaubsantrag"
                text="Diese Funktion ist vorbereitet und wird später aktiviert."
                onOpen={() => setPlaceholder({
                  title: "Urlaubsantrag",
                  text: "Hier werden später Urlaubsanträge erfasst und an das Büro übergeben.",
                })}
              />
              <PlaceholderAction
                compact
                icon={HeartPulse}
                tone="sickness"
                title="Krankmeldung"
                text="Diese Funktion ist vorbereitet und wird später aktiviert."
                onOpen={() => setPlaceholder({
                  title: "Krankmeldung",
                  text: "Hier werden später Krankmeldungen erfasst und mit der persönlichen Akte verknüpft.",
                })}
              />
            </div>
            <div className="mobile-home-secondary-actions">
              <PlaceholderAction
                compact
                icon={Settings}
                tone="settings"
                title="Einstellungen"
                text="App-Einstellungen und persönliche Optionen."
                onOpen={() => setActiveScreen("settings")}
              />
            </div>
          </section>
        </>
      )}

      {placeholder ? <MobilePlaceholderDialog content={placeholder} onClose={() => setPlaceholder(null)} /> : null}
      {selfPlanSheet ? (
        <MobileSelfPlanSheet
          error={selfPlanError}
          isLoading={isLoadingSelfPlanSites}
          planningSiteId={selfPlanningSiteId}
          sheet={selfPlanSheet}
          sites={recentSelfPlanSites ?? []}
          onClose={() => setSelfPlanSheet(null)}
          onSelectSite={(site) => void handleSelfPlanSite(site)}
        />
      ) : null}
    </section>
  );
}

type AndroidGpsPermissionPrompt = {
  kind: "foreground" | "background" | "notifications";
  title: string;
  text: string;
  actionLabel: string;
};

function hasRequiredAndroidGpsPermissions(permissions: AndroidGpsPermissionStatus | null): boolean {
  return Boolean(
    permissions?.foregroundLocationGranted
      && permissions.backgroundLocationGranted
      && permissions.notificationsGranted,
  );
}

function readGpsTrackingPreference(): boolean {
  try {
    const stored = localStorage.getItem(GPS_TRACKING_ENABLED_KEY);
    if (stored === "true") {
      return true;
    }
    if (stored === "false") {
      return false;
    }
  } catch {
    return isAndroidAppContext();
  }
  return isAndroidAppContext();
}

function writeGpsTrackingPreference(isEnabled: boolean): void {
  try {
    localStorage.setItem(GPS_TRACKING_ENABLED_KEY, String(isEnabled));
  } catch {
    // Ignore storage failures; the in-memory toggle still controls this session.
  }
}

function readPushNotificationPreference(): boolean {
  try {
    return localStorage.getItem(PUSH_NOTIFICATIONS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function writePushNotificationPreference(isEnabled: boolean): void {
  try {
    localStorage.setItem(PUSH_NOTIFICATIONS_ENABLED_KEY, String(isEnabled));
  } catch {
    // Ignore storage failures; the in-memory toggle still controls this session.
  }
}

function getAndroidGpsPermissionPrompt(permissions: AndroidGpsPermissionStatus | null): AndroidGpsPermissionPrompt | null {
  if (!permissions) {
    return null;
  }
  if (!permissions.foregroundLocationGranted) {
    return {
      kind: "foreground",
      title: "Standort erlauben",
      text: "Für die automatische Arbeitszeitprüfung benötigt die App Standortzugriff.",
      actionLabel: "Standort erlauben",
    };
  }
  if (!permissions.notificationsGranted) {
    return {
      kind: "notifications",
      title: "Benachrichtigung erlauben",
      text: "Damit Android die laufende Standortprüfung anzeigen kann, muss die App Benachrichtigungen senden dürfen.",
      actionLabel: "Berechtigung erlauben",
    };
  }
  if (!permissions.backgroundLocationGranted) {
    return {
      kind: "background",
      title: "Standort auf Immer erlauben stellen",
      text: "Damit die automatische Arbeitszeitprüfung auch bei gesperrtem Handy funktioniert, muss der Standortzugriff auf Immer erlauben gestellt werden.",
      actionLabel: "App-Einstellungen öffnen",
    };
  }
  return null;
}

function MobileHomeTimelineCard({
  isNext,
  item,
  today,
  onEmptyDaySelect,
}: {
  isNext: boolean;
  item: MobileHomeTimelineItem;
  today: string;
  onEmptyDaySelect?: (date: string, label: string) => void;
}) {
  const assignment = item.assignment;
  const isToday = item.start === today;
  const dateLabel = formatHomeTimelineDateRange(item.start, item.end);
  const weekdayLabel = formatHomeTimelineWeekdayRange(item.start, item.end);
  const secondaryText = assignment
    ? [assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")
    : "Antippen, falls du trotzdem auf Baustelle bist.";
  const cardContent = (
    <>
      <span className={`mobile-home-timeline-date${isNext ? " is-next" : ""}`}>
        <em>{isNext ? "Als nächstes" : "Danach"}</em>
        <strong>{weekdayLabel}</strong>
        <span>{dateLabel}</span>
      </span>
      <span className="mobile-home-timeline-main">
        <span className="mobile-home-timeline-copy">
          <b title={assignment?.site.name ?? "Kein Einsatz geplant."}>
            {assignment?.site.name ?? "Kein Einsatz geplant."}
          </b>
          <small title={secondaryText}>{secondaryText}</small>
          {item.dayCount > 1 ? (
            <span className="mobile-home-timeline-duration">{item.dayCount} Einsatztage</span>
          ) : null}
        </span>
        <span className="assignment-card-affordance">
          <ChevronRight aria-hidden="true" size={18} />
        </span>
      </span>
    </>
  );

  if (assignment) {
    return (
      <Link
        aria-label={`${formatRangeLabel(item.start, item.end)}: ${assignment.site.name}`}
        className={`mobile-home-timeline-card${isNext ? " is-next" : ""}`}
        data-mobile-home-timeline-item
        state={{ assignment }}
        to={`/me/assignments/${assignment.id}`}
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <button
      aria-label={`${formatDate(item.start)}: Kein Einsatz geplant. Einsatz nachtragen`}
      className={`mobile-home-timeline-card is-empty${isNext ? " is-next" : ""}`}
      data-mobile-home-timeline-item
      type="button"
      onClick={() => onEmptyDaySelect?.(
        item.start,
        isToday ? `Heute · ${formatShortDate(item.start)}` : formatHomeAssignmentDateLabel(item.start),
      )}
    >
      {cardContent}
    </button>
  );
}

function MobileAssignmentSiteCard({
  summary,
  onOpen,
}: {
  summary: MobileAssignmentSiteSummary;
  onOpen: () => void;
}) {
  const site = summary.site;
  const metadata = [site.site_number, site.location || site.address, site.customer].filter(Boolean).join(" · ");
  return (
    <button className="mobile-assignment-site-card" type="button" onClick={onOpen}>
      <span className="mobile-assignment-site-icon" aria-hidden="true">
        <CalendarClock size={21} />
      </span>
      <span className="mobile-assignment-site-copy">
        <strong>{formatAssignmentHistoryCardDate(summary.last_assignment_date)}</strong>
        <b>{site.name}</b>
        {metadata ? <small>{metadata}</small> : null}
      </span>
      <span className="mobile-assignment-site-actions">
        <SiteStatusBadge status={site.status} />
        <ChevronRight aria-hidden="true" size={21} />
      </span>
    </button>
  );
}

function MobileAssignmentSiteHistory({
  error,
  history,
  isLoading,
  summary,
  onBack,
  onOpenProjectFile,
  onRetry,
}: {
  error: string | null;
  history: MobileAssignmentSiteHistoryResponse | null;
  isLoading: boolean;
  summary: MobileAssignmentSiteSummary;
  onBack: () => void;
  onOpenProjectFile: (assignment: MobileAssignment) => void;
  onRetry: () => void;
}) {
  const site = history?.site ?? summary.site;
  const metadata = [site.site_number, site.location || site.address, site.customer].filter(Boolean).join(" · ");
  const weeks = buildMobileAssignmentHistoryWeeks(history?.assignments ?? []);
  const projectFileAssignment = history?.assignments[0] ?? null;
  return (
    <section className="mobile-page mobile-home-page mobile-assignment-history-page">
      <header className="mobile-assignment-history-header">
        <MobileBackButton label="Zurück zu Meine Einsätze" onClick={onBack} />
        <div>
          <h1>{site.name}</h1>
          {metadata ? <p>{metadata}</p> : null}
        </div>
      </header>

      {error ? (
        <MobileAssignmentHistoryState
          actionLabel="Erneut versuchen"
          message={error}
          tone="error"
          onAction={onRetry}
        />
      ) : null}
      {isLoading ? <MobileAssignmentHistoryState message="Einsatzhistorie wird geladen ..." /> : null}
      {!isLoading && !error && projectFileAssignment ? (
        <button
          className="mobile-assignment-project-file-action"
          type="button"
          onClick={() => onOpenProjectFile(projectFileAssignment)}
        >
          <span className="mobile-assignment-project-file-icon" aria-hidden="true">
            <FolderOpen size={23} />
          </span>
          <span className="mobile-assignment-project-file-copy">
            <strong>Baustellenakte öffnen</strong>
            <small>Ordner, Aufmaße und Stundenzettel</small>
          </span>
          <ChevronRight aria-hidden="true" size={21} />
        </button>
      ) : null}
      {!isLoading && !error && history && !weeks.length ? (
        <MobileAssignmentHistoryState message="Für diese Baustelle sind keine Einsätze vorhanden." />
      ) : null}
      {!isLoading && !error && weeks.length ? (
        <div className="mobile-assignment-week-list">
          {weeks.map((week) => (
            <article className="mobile-assignment-week-card" key={`${week.isoYear}-${week.isoWeek}`}>
              <div className="mobile-assignment-week-heading">
                <strong>KW {week.isoWeek}</strong>
                <span>{week.isoYear}</span>
              </div>
              <div className="mobile-assignment-week-periods">
                {week.periods.map((period) => (
                  <p key={`${period.start}-${period.end}`}>{formatAssignmentHistoryPeriod(period.start, period.end)}</p>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MobileAssignmentHistoryState({
  actionLabel,
  message,
  tone = "neutral",
  onAction,
}: {
  actionLabel?: string;
  message: string;
  tone?: "neutral" | "error";
  onAction?: () => void;
}) {
  return (
    <div className={`mobile-assignment-history-state${tone === "error" ? " is-error" : ""}`}>
      <p>{message}</p>
      {actionLabel && onAction ? <button type="button" onClick={onAction}>{actionLabel}</button> : null}
    </div>
  );
}

function PlaceholderAction({
  icon: Icon,
  tone,
  title,
  text,
  onOpen,
  compact = false,
  disabled = false,
}: {
  icon: typeof FileText;
  tone: "time" | "vacation" | "sickness" | "deployments" | "profile" | "settings";
  title: string;
  text: string;
  onOpen: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={`${title}: ${text}`}
      className={`mobile-action-card mobile-action-card--${tone}${compact ? " is-compact" : ""}`}
      type="button"
      disabled={disabled}
      onClick={onOpen}
    >
      <Icon className="mobile-action-icon" aria-hidden="true" size={20} />
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <ChevronRight className="mobile-action-chevron" aria-hidden="true" size={18} />
    </button>
  );
}

function MobilePlaceholderDialog({ content, onClose }: { content: PlaceholderContent; onClose: () => void }) {
  const isTopModal = useMobileModalStack(true);
  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="mobile-placeholder-dialog mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-placeholder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="mobile-placeholder-title">{content.title}</h2>
        <p>{content.text}</p>
        <button className="primary-action" type="button" onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}

function MobileSelfPlanSheet({
  error,
  isLoading,
  planningSiteId,
  sheet,
  sites,
  onClose,
  onSelectSite,
}: {
  error: string | null;
  isLoading: boolean;
  planningSiteId: number | null;
  sheet: SelfPlanSheetState;
  sites: MobileSite[];
  onClose: () => void;
  onSelectSite: (site: MobileSite) => void;
}) {
  const isTopModal = useMobileModalStack(true);
  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-dialog-backdrop mobile-bottom-sheet-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="mobile-bottom-sheet mobile-modal-scroll-region"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-self-plan-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-bottom-sheet-head">
          <div>
            <h2 id="mobile-self-plan-title">Baustelle nachtragen</h2>
            <p>{sheet.label}: Nur verwenden, wenn du arbeitest, aber keine Planung eingetragen ist.</p>
          </div>
          <button className="icon-button secondary" type="button" onClick={onClose}>Abbrechen</button>
        </div>
        {error ? <p className="form-error mobile-self-plan-message">{error}</p> : null}
        {isLoading ? <p className="empty-inline">Baustellen werden geladen...</p> : null}
        {!isLoading && !sites.length ? (
          <p className="empty-inline">Keine früher geplanten Baustellen gefunden.</p>
        ) : null}
        <div className="mobile-self-plan-site-list">
          {sites.map((site) => (
            <button
              className="mobile-self-plan-site-card"
              disabled={planningSiteId !== null}
              key={site.id}
              type="button"
              onClick={() => onSelectSite(site)}
            >
              <strong>{site.name}</strong>
              <span>{[site.site_number, site.customer, site.location].filter(Boolean).join(" · ") || "Baustelle"}</span>
              {planningSiteId === site.id ? <em>Wird nachgetragen...</em> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileGpsDebugCard({
  platform,
  permissions,
  status,
  lastAutomaticSentAt,
}: {
  platform: string;
  permissions: AndroidGpsPermissionStatus | null;
  status: AndroidBackgroundGpsStatus | null;
  lastAutomaticSentAt: string | null;
}) {
  const backgroundAvailable = platform === "android" && isAndroidAppContext();
  const nextPingLabel = status?.nextPingAt ? formatDateTime(status.nextPingAt) : "-";
  return (
    <div className="mobile-gps-debug-card" aria-label="GPS Status">
      <div className="mobile-gps-debug-card-head">
        <strong>GPS-Status</strong>
        <span>Testphase</span>
      </div>
      <dl className="mobile-gps-debug-grid">
        <div><dt>Plattform</dt><dd>{platform}</dd></div>
        <div><dt>Background verfügbar</dt><dd>{formatYesNo(backgroundAvailable)}</dd></div>
        <div><dt>Background aktiv</dt><dd>{formatYesNo(status?.isTracking)}</dd></div>
        <div><dt>Service läuft</dt><dd>{formatYesNo(status?.isServiceRunning)}</dd></div>
        <div><dt>Foreground-Service</dt><dd>{formatYesNo(status?.isForegroundServiceRunning)}</dd></div>
        <div><dt>Standort foreground</dt><dd>{formatYesNo(permissions?.foregroundLocationGranted)}</dd></div>
        <div><dt>Standort immer erlauben</dt><dd>{formatYesNo(permissions?.backgroundLocationGranted)}</dd></div>
        <div><dt>Benachrichtigung</dt><dd>{formatYesNo(permissions?.notificationsGranted)}</dd></div>
        <div><dt>Letzte automatische Sendung</dt><dd>{formatOptionalDateTime(lastAutomaticSentAt)}</dd></div>
        <div><dt>Offline-Queue</dt><dd>{status?.queuedCount ?? 0}</dd></div>
        <div><dt>Zuletzt gepuffert</dt><dd>{formatOptionalDateTime(status?.lastQueuedAt ?? null)}</dd></div>
        <div><dt>Service-Start</dt><dd>{formatOptionalDateTime(status?.lastServiceStartAt ?? null)}</dd></div>
        <div><dt>Service-Stop</dt><dd>{formatOptionalDateTime(status?.lastServiceStopAt ?? null)}</dd></div>
        <div><dt>Nächster Ping</dt><dd>{nextPingLabel}</dd></div>
      </dl>
      {status?.lastError ? <p className="mobile-gps-debug-error">Letzter Fehler: {status.lastError}</p> : null}
    </div>
  );
}

function getUpcomingRange(): { start: string; end: string } {
  const today = startOfToday();
  return {
    start: toIsoDate(today),
    end: toIsoDate(addDays(today, 13)),
  };
}

function expandAssignmentsByDay(assignments: MobileAssignment[], start: string, end: string): DailyAssignment[] {
  const days: DailyAssignment[] = [];
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  for (const assignment of assignments) {
    const first = maxDate(parseIsoDate(assignment.start_date), startDate);
    const last = minDate(parseIsoDate(assignment.end_date), endDate);
    if (first > last) {
      continue;
    }
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const date = toIsoDate(day);
      days.push({ key: `${assignment.id}:${date}`, date, assignment });
    }
  }
  return days.sort((left, right) => left.date.localeCompare(right.date));
}

function groupDailyAssignments(entries: DailyAssignment[]): Map<string, DailyAssignment[]> {
  const grouped = new Map<string, DailyAssignment[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.date) ?? [];
    list.push(entry);
    grouped.set(entry.date, list);
  }
  return grouped;
}

function buildMobileHomeTimelineItems(
  dates: string[],
  assignmentsByDate: Map<string, DailyAssignment[]>,
): MobileHomeTimelineItem[] {
  const items: MobileHomeTimelineItem[] = [];
  const latestItemByAssignmentId = new Map<number, MobileHomeTimelineItem>();
  let order = 0;

  for (const date of dates) {
    const assignments = (assignmentsByDate.get(date) ?? []).filter(hasRealDailyAssignment);
    if (!assignments.length) {
      items.push({
        key: `empty:${date}`,
        start: date,
        end: date,
        dayCount: 1,
        assignment: null,
        order,
      });
      order += 1;
      continue;
    }

    for (const daily of assignments) {
      const previous = latestItemByAssignmentId.get(daily.assignment.id);
      const continuesPrevious = previous
        && toIsoDate(addDays(parseIsoDate(previous.end), 1)) === date;
      if (continuesPrevious) {
        previous.end = date;
        previous.dayCount += 1;
        previous.key = `assignment:${daily.assignment.id}:${previous.start}:${date}`;
        continue;
      }

      const item: MobileHomeTimelineItem = {
        key: `assignment:${daily.assignment.id}:${date}`,
        start: date,
        end: date,
        dayCount: 1,
        assignment: daily.assignment,
        order,
      };
      items.push(item);
      latestItemByAssignmentId.set(daily.assignment.id, item);
      order += 1;
    }
  }

  return items.sort((left, right) => (
    left.start.localeCompare(right.start)
    || left.order - right.order
  ));
}

function chunkMobileHomeTimelineItems(items: MobileHomeTimelineItem[]): MobileHomeTimelineItem[][] {
  const pages: MobileHomeTimelineItem[][] = [];
  for (let index = 0; index < items.length; index += MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE) {
    pages.push(items.slice(index, index + MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE));
  }
  return pages;
}

function getDayRange(start: string, count: number): string[] {
  const startDate = parseIsoDate(start);
  return Array.from({ length: count }, (_, index) => toIsoDate(addDays(startDate, index)));
}

function shouldShowMobileUpcomingDay(date: string, assignments: DailyAssignment[]): boolean {
  return !isWeekendDay(date) || assignments.some(hasRealDailyAssignment);
}

function hasRealDailyAssignment(entry: DailyAssignment): boolean {
  return entry.assignment.site.id > 0 && entry.assignment.site.name.trim().length > 0;
}

function isWeekendDay(date: string): boolean {
  const day = parseIsoDate(date).getDay();
  return day === 0 || day === 6;
}

function getAssignmentsCacheKey(userId: number | null): string | null {
  return userId === null ? null : `${CACHE_KEY_PREFIX}:${userId}`;
}

function readCache(cacheKey: string | null): CachePayload | null {
  if (cacheKey === null) {
    return null;
  }
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) {
      return null;
    }
    const cached = JSON.parse(raw) as Partial<CachePayload>;
    if (
      typeof cached.loadedAt !== "string"
      || !cached.data
      || !Array.isArray(cached.data.assignments)
    ) {
      return null;
    }
    return cached as CachePayload;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string | null, payload: CachePayload): void {
  if (cacheKey === null) {
    return;
  }
  try {
    localStorage.setItem(cacheKey, JSON.stringify(payload));
  } catch {
    // Der Online-Stand bleibt nutzbar, auch wenn der Browser keinen Cache schreiben kann.
  }
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message;
}

function upsertMobileAssignment(
  current: MobileAssignmentsResponse,
  assignment: MobileAssignment,
): MobileAssignmentsResponse {
  const withoutCurrent = current.assignments.filter((item) => item.id !== assignment.id);
  const assignments = [...withoutCurrent, assignment].sort((left, right) => (
    left.start_date.localeCompare(right.start_date)
      || left.end_date.localeCompare(right.end_date)
      || left.id - right.id
  ));
  return { ...current, assignments };
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function minDate(left: Date, right: Date): Date {
  return left < right ? left : right;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(parseIsoDate(date));
}

function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(parseIsoDate(date));
}

function formatWeekday(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(parseIsoDate(date));
}

function formatAssignmentHistoryCardDate(date: string): string {
  return `${formatWeekday(date).replace(/\.$/, "")}, ${formatDate(date)}`;
}

function formatAssignmentHistoryPeriod(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

function formatHomeAssignmentDateLabel(date: string): string {
  return `${formatWeekday(date).replace(/\.$/, "")} · ${formatShortDate(date)}`;
}

function formatHomeTimelineWeekdayRange(start: string, end: string): string {
  const first = formatWeekday(start).replace(/\.$/, "");
  if (start === end) {
    return first;
  }
  return `${first}–${formatWeekday(end).replace(/\.$/, "")}`;
}

function formatHomeTimelineDateRange(start: string, end: string): string {
  if (start === end) {
    return formatShortDate(start);
  }
  const first = parseIsoDate(start);
  const last = parseIsoDate(end);
  if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) {
    return `${String(first.getDate()).padStart(2, "0")}.–${formatShortDate(end)}`;
  }
  return `${formatShortDate(start)}–${formatShortDate(end)}`;
}

function formatHomeOverviewDate(date: string): string {
  const formatted = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parseIsoDate(date));
  return `${formatted.charAt(0).toLocaleUpperCase("de-DE")}${formatted.slice(1)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatOptionalDateTime(value: string | null | undefined): string {
  return value ? formatDateTime(value) : "-";
}

function formatYesNo(value: boolean | null | undefined): string {
  if (value === undefined || value === null) {
    return "-";
  }
  return value ? "ja" : "nein";
}

function formatRangeLabel(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} bis ${formatDate(end)}`;
}
