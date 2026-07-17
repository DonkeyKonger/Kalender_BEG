import {
  ArrowLeft,
  CalendarClock,
  ChevronRight,
  Clock,
  FileText,
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
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { SiteStatusBadge } from "../components/StatusBadge";
import { ApiError, api } from "../lib/api";
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
import { canUsePushNotifications, initializePushNotifications } from "../lib/pushNotifications";
import type { AndroidBackgroundGpsStatus, AndroidGpsPermissionStatus } from "../lib/mobileGps";
import type { MobileAssignment, MobileAssignmentsResponse, MobileSite } from "../types/mobile";

const CACHE_KEY_PREFIX = "kb_mobile_assignments_cache_v2";
const GPS_TRACKING_ENABLED_KEY = "kb_mobile_gps_tracking_enabled_v1";
const PUSH_NOTIFICATIONS_ENABLED_KEY = "kb_mobile_push_notifications_enabled_v1";
const MOBILE_HOME_DAY_WINDOW = 7;
const MOBILE_HOME_VISIBLE_DAY_COUNT = 4;

type MobileViewMode = "two_weeks" | "year";

type CachePayload = {
  loadedAt: string;
  mode: MobileViewMode;
  data: MobileAssignmentsResponse;
};

type DailyAssignment = {
  key: string;
  date: string;
  assignment: MobileAssignment;
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
  const [mode, setMode] = useState<MobileViewMode>("two_weeks");
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
  const assignmentLoadRequestIdRef = useRef(0);

  const range = useMemo(() => getRange(mode), [mode]);
  const assignmentCacheKey = useMemo(
    () => getAssignmentsCacheKey(user?.id ?? null, mode),
    [mode, user?.id],
  );

  const loadAssignments = useCallback(async () => {
    const requestId = ++assignmentLoadRequestIdRef.current;
    setIsLoading(true);
    setError(null);
    setIsFromCache(false);
    try {
      const response = mode === "year"
        ? await api.myAssignmentHistory(range)
        : await api.myAssignments(range);
      if (requestId !== assignmentLoadRequestIdRef.current) {
        return;
      }
      const timestamp = new Date().toISOString();
      const cachePayload: CachePayload = { loadedAt: timestamp, mode, data: response };
      writeCache(assignmentCacheKey, cachePayload);
      setData(response);
      setLoadedAt(timestamp);
    } catch (requestError) {
      if (requestId !== assignmentLoadRequestIdRef.current) {
        return;
      }
      const cached = readCache(assignmentCacheKey, mode);
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
  }, [assignmentCacheKey, mode, range]);

  useEffect(() => {
    void loadAssignments();
    return () => {
      assignmentLoadRequestIdRef.current += 1;
    };
  }, [loadAssignments]);

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

  function selectAssignmentMode(nextMode: MobileViewMode): void {
    if (nextMode === mode) {
      return;
    }
    assignmentLoadRequestIdRef.current += 1;
    setIsLoading(true);
    setError(null);
    setIsFromCache(false);
    setData(null);
    setLoadedAt(null);
    setMode(nextMode);
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
        writeCache(assignmentCacheKey, { loadedAt: timestamp, mode, data: nextData });
        return nextData;
      });
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
    () => getDayRange(today, MOBILE_HOME_DAY_WINDOW)
      .filter((date) => shouldShowMobileUpcomingDay(date, dailyByDate.get(date) ?? []))
      .slice(0, MOBILE_HOME_VISIBLE_DAY_COUNT),
    [dailyByDate, today],
  );
  const yearGroups = useMemo(
    () => groupAssignmentsForLongView(data?.assignments ?? [], range.start, range.end),
    [data?.assignments, range.end, range.start],
  );
  const androidGpsPermissionPrompt = getAndroidGpsPermissionPrompt(androidGpsPermissions);
  const mobileGpsPlatform = getMobileGpsPlatform();
  const showGpsDebug = import.meta.env.DEV;
  const showGpsDebugStatus = showGpsDebug && user?.role === "monteur";
  const canUseAndroidGpsTracking = user?.role === "monteur" && isAndroidAppContext();
  const gpsToggleLabel = isGpsTrackingEnabled ? "Ortung aktiv" : "Ortung aus";
  const canUseAppPushNotifications = canUsePushNotifications();
  const pushToggleLabel = isPushNotificationsEnabled ? "Benachrichtigungen ein" : "Benachrichtigungen aus";
  const greetingName = getGreetingName(user?.display_name || user?.username || "");

  if (activeScreen === "assignments") {
    return (
      <section className="mobile-page mobile-home-page">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={() => setActiveScreen("home")}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>

        <header className="mobile-subpage-title">
          <p className="eyebrow">Einsatzliste</p>
          <h1>Meine Einsätze</h1>
        </header>

        <div className="mobile-segment" role="group" aria-label="Zeitraum">
          <button
            className={mode === "two_weeks" ? "active" : ""}
            type="button"
            onClick={() => selectAssignmentMode("two_weeks")}
          >
            14 Tage
          </button>
          <button
            className={mode === "year" ? "active" : ""}
            type="button"
            onClick={() => selectAssignmentMode("year")}
          >
            Jahr
          </button>
        </div>

        {loadedAt && (
          <p className={isFromCache ? "cache-note warning" : "cache-note"}>
            Stand: {formatDateTime(loadedAt)}{isFromCache ? " - Lesecache" : ""}
          </p>
        )}
        {error && <p className={isFromCache ? "form-info" : "form-error"}>{error}</p>}
        {isLoading ? <div className="empty-panel">Einsätze werden geladen...</div> : null}

        {!isLoading && mode === "two_weeks" ? (
          <div className="mobile-day-list">
            {nextFourteenDays.map((date) => (
              <DayListCard date={date} assignments={dailyByDate.get(date) ?? []} key={date} />
            ))}
          </div>
        ) : null}
        {!isLoading && mode === "year" ? (
          <div className="mobile-day-list">
            {yearGroups.length ? yearGroups.map((group) => (
              <AssignmentRangeCard group={group} key={group.key} />
            )) : <p className="empty-inline">Keine Einsätze im Zeitraum.</p>}
          </div>
        ) : null}
      </section>
    );
  }

  if (activeScreen === "settings") {
    return (
      <section className="mobile-page mobile-home-page">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={() => setActiveScreen("home")}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>

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
        </div>
      </section>
    );
  }

  return (
    <section className="mobile-page mobile-home-page">
      <div className="mobile-home-actions" aria-label="Startseitenaktionen">
        <button className="icon-button secondary" type="button" onClick={() => void loadAssignments()}>
          <RefreshCcw aria-hidden="true" size={17} />
          <span>Aktualisieren</span>
        </button>
        <button className="icon-button" type="button" onClick={() => void handleLogout()}>
          <LogOut aria-hidden="true" size={17} />
          <span>Abmelden</span>
        </button>
      </div>

      <header className="mobile-home-title-card">
        <div className="mobile-home-title-main">
          <span className="mobile-home-hero-icon"><CalendarClock aria-hidden="true" size={25} /></span>
          <div>
            <h1>Baustellenkalender</h1>
            {loadedAt ? (
              <p className="mobile-home-stand">
                <Clock aria-hidden="true" size={15} />
                <span>Stand: {formatDateTime(loadedAt)}{isFromCache ? " - Lesecache" : ""}</span>
              </p>
            ) : null}
            <p className="mobile-home-greeting">Hallo {greetingName}</p>
          </div>
        </div>
        <span className={isFromCache ? "mobile-home-status-badge is-cache" : "mobile-home-status-badge"}>
          {isFromCache ? "Offline" : "Online"}
        </span>
      </header>

      {error && <p className={isFromCache ? "form-info" : "form-error"}>{error}</p>}
      {isLoading && <div className="empty-panel">Einsätze werden geladen...</div>}

      {!isLoading && (
        <>
          <section className="mobile-home-section">
            <div className="mobile-section-heading">
              <h2>Nächste Einsätze</h2>
            </div>
            <div className="mobile-home-assignment-group">
              {mobileHomeDays.map((date) => (
                <DayFocusCard
                  date={date}
                  label={date === today ? "Heute" : formatWeekday(date)}
                  assignments={dailyByDate.get(date) ?? []}
                  compact={date !== today}
                  key={date}
                  onEmptyDaySelect={(workDate, label) => void openSelfPlanSheet(workDate, label)}
                />
              ))}
            </div>
          </section>

          <section className="mobile-home-section">
            <div className="mobile-action-list">
              <PlaceholderAction
                icon={FileText}
                tone="time"
                title="Lohnzeit erfassen"
                text="Arbeitszeit tagesbezogen eintragen oder ändern."
                onOpen={() => navigate("/me/time-entry")}
              />
              <PlaceholderAction
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
                icon={HeartPulse}
                tone="sickness"
                title="Krankmeldung"
                text="Diese Funktion ist vorbereitet und wird später aktiviert."
                onOpen={() => setPlaceholder({
                  title: "Krankmeldung",
                  text: "Hier werden später Krankmeldungen erfasst und mit der persönlichen Akte verknüpft.",
                })}
              />
              <PlaceholderAction
                icon={CalendarClock}
                tone="deployments"
                title="Alle Einsätze anzeigen"
                text="Öffnet die vollständige Einsatzliste mit 14-Tage- und Jahresansicht."
                onOpen={() => setActiveScreen("assignments")}
              />
              <PlaceholderAction
                icon={UserCircle}
                tone="profile"
                title="Persönliche Akte"
                text="Resturlaub, Krankheitstage sowie Fahrzeug- und Werkzeugzuordnung anzeigen."
                onOpen={() => navigate("/me/personal-file")}
              />
              <PlaceholderAction
                icon={Settings}
                tone="settings"
                title="Einstellungen"
                text="Standortprüfung und Benachrichtigungen verwalten."
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

function getGreetingName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "zusammen";
  }
  return trimmed.split(/\s+/)[0] ?? trimmed;
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

function DayFocusCard({
  date,
  label,
  assignments,
  compact = false,
  onEmptyDaySelect,
}: {
  date: string;
  label: string;
  assignments: DailyAssignment[];
  compact?: boolean;
  onEmptyDaySelect?: (date: string, label: string) => void;
}) {
  if (assignments.length > 1) {
    return (
      <article className={`mobile-focus-card mobile-home-day-assignment-cluster${compact ? " is-upcoming" : ""}`}>
        <div className="mobile-home-day-assignment-grid">
          {assignments.map((daily) => (
            <CompactHomeAssignmentCard
              assignment={daily.assignment}
              date={date}
              key={daily.key}
            />
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className={`mobile-focus-card${compact ? " is-upcoming" : ""}`}>
      {assignments.length ? assignments.map((daily) => (
        <HomeAssignmentCard
          assignment={daily.assignment}
          date={date}
          key={daily.key}
        />
      )) : (
        <button
          className="mobile-home-empty-day"
          type="button"
          onClick={() => onEmptyDaySelect?.(date, compact ? `${label} · ${formatShortDate(date)}` : "Heute")}
        >
          <span className="mobile-home-assignment-icon">
            <CalendarClock aria-hidden="true" size={22} />
          </span>
          <span>
            <strong>{formatHomeAssignmentDateLabel(date)}</strong>
            <b>Kein Einsatz geplant.</b>
            <small>Antippen, falls du trotzdem auf Baustelle bist.</small>
          </span>
        </button>
      )}
    </article>
  );
}

function CompactHomeAssignmentCard({
  assignment,
  date,
}: {
  assignment: MobileAssignment;
  date: string;
}) {
  return (
    <Link
      className="mobile-home-assignment-card is-day-cluster-item"
      to={`/me/assignments/${assignment.id}`}
      state={{ assignment }}
    >
      <span className="mobile-home-assignment-icon">
        <CalendarClock aria-hidden="true" size={20} />
      </span>
      <span>
        <strong>{formatHomeAssignmentDateLabel(date)}</strong>
        <b>{assignment.site.name}</b>
        <small>{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</small>
      </span>
      <span className="assignment-card-affordance">
        <ChevronRight aria-hidden="true" size={15} />
      </span>
    </Link>
  );
}

function HomeAssignmentCard({
  assignment,
  date,
}: {
  assignment: MobileAssignment;
  date: string;
}) {
  return (
    <Link
      className="mobile-home-assignment-card"
      to={`/me/assignments/${assignment.id}`}
      state={{ assignment }}
    >
      <span className="mobile-home-assignment-icon">
        <CalendarClock aria-hidden="true" size={22} />
      </span>
      <span>
        <strong>{formatHomeAssignmentDateLabel(date)}</strong>
        <b>{assignment.site.name}</b>
        <small>{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</small>
      </span>
      <span className="assignment-card-affordance">
        <ChevronRight aria-hidden="true" size={17} />
      </span>
    </Link>
  );
}

function DayListCard({ date, assignments }: { date: string; assignments: DailyAssignment[] }) {
  return (
    <article className="mobile-day-card">
      <div className="mobile-day-card-date">
        <strong>{formatWeekday(date)}</strong>
        <span>{formatShortDate(date)}</span>
      </div>
      <div className="mobile-day-card-content">
        {assignments.length ? assignments.map((daily) => (
          <AssignmentCard assignment={daily.assignment} date={date} compact key={daily.key} />
        )) : <span className="mobile-day-empty">Kein Einsatz geplant</span>}
      </div>
    </article>
  );
}

function AssignmentRangeCard({ group }: { group: AssignmentRangeGroup }) {
  const site = group.assignment.site;
  return (
    <Link className="assignment-card assignment-card-link mobile-range-card" to={`/me/assignments/${group.assignment.id}`} state={{ assignment: group.assignment }}>
      <div>
        <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatRangeLabel(group.start, group.end)}</p>
        <h3>{site.name}</h3>
        <p className="muted-text">{[site.site_number, site.location || site.address, site.customer].filter(Boolean).join(" · ")}</p>
      </div>
      <SiteStatusBadge status={site.status} />
    </Link>
  );
}

function PlaceholderAction({
  icon: Icon,
  tone,
  title,
  text,
  onOpen,
  disabled = false,
}: {
  icon: typeof FileText;
  tone: "time" | "vacation" | "sickness" | "deployments" | "profile" | "settings";
  title: string;
  text: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`mobile-action-card mobile-action-card--${tone}`}
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
  return (
    <div className="mobile-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="mobile-placeholder-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-placeholder-title" onClick={(event) => event.stopPropagation()}>
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
  return (
    <div className="mobile-dialog-backdrop mobile-bottom-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="mobile-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-self-plan-title" onClick={(event) => event.stopPropagation()}>
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

function AssignmentCard({ assignment, date, compact = false }: { assignment: MobileAssignment; date?: string; compact?: boolean }) {
  return (
    <Link className={`assignment-card assignment-card-link${compact ? " is-compact" : ""}`} to={`/me/assignments/${assignment.id}`} state={{ assignment }}>
      <div className="assignment-card-main">
        <div>
          <p className="assignment-date">
            <CalendarClock aria-hidden="true" size={15} />
            {date ? formatShortDate(date) : formatAssignmentRange(assignment)}
          </p>
          <h3>{assignment.site.name}</h3>
          <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
        </div>
        <span className="assignment-card-affordance">
          <SiteStatusBadge status={assignment.site.status} />
          <ChevronRight aria-hidden="true" size={17} />
        </span>
      </div>

      {!compact ? (
        <div className="assignment-detail-list">
          {(assignment.site.location || assignment.site.address) && (
            <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
          )}
          {assignment.site.project_manager && (
            <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
          )}
        </div>
      ) : null}

      {assignment.note && !compact ? <p className="assignment-note">{assignment.note}</p> : null}
    </Link>
  );
}

type AssignmentRangeGroup = {
  key: string;
  assignment: MobileAssignment;
  start: string;
  end: string;
};

function getRange(mode: MobileViewMode): { start: string; end: string } {
  const today = startOfToday();
  if (mode === "year") {
    return {
      start: toIsoDate(addCalendarMonths(today, -12)),
      end: toIsoDate(today),
    };
  }
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

function groupAssignmentsForLongView(assignments: MobileAssignment[], start: string, end: string): AssignmentRangeGroup[] {
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);
  const candidates = assignments
    .map((assignment) => ({
      assignment,
      start: toIsoDate(maxDate(parseIsoDate(assignment.start_date), startDate)),
      end: toIsoDate(minDate(parseIsoDate(assignment.end_date), endDate)),
    }))
    .filter((group) => group.start <= group.end)
    .sort((left, right) => (
      left.assignment.site.id - right.assignment.site.id
      || left.start.localeCompare(right.start)
      || left.end.localeCompare(right.end)
      || left.assignment.id - right.assignment.id
    ));
  const groups: AssignmentRangeGroup[] = [];

  for (const candidate of candidates) {
    const previous = groups.at(-1);
    if (
      !previous
      || previous.assignment.site.id !== candidate.assignment.site.id
      || candidate.start > toIsoDate(addDays(parseIsoDate(previous.end), 1))
    ) {
      groups.push({
        key: `${candidate.assignment.site.id}:${candidate.start}:${candidate.end}:${candidate.assignment.id}`,
        ...candidate,
      });
      continue;
    }
    previous.key = `${previous.key}:${candidate.assignment.id}`;
    if (candidate.end > previous.end) {
      previous.end = candidate.end;
      previous.assignment = candidate.assignment;
    }
  }

  return groups.sort((left, right) => (
    right.end.localeCompare(left.end)
    || right.start.localeCompare(left.start)
    || (left.assignment.site.site_number ?? "").localeCompare(
      right.assignment.site.site_number ?? "",
      "de",
      { numeric: true, sensitivity: "base" },
    )
    || left.assignment.site.name.localeCompare(right.assignment.site.name, "de", { sensitivity: "base" })
  ));
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

function getAssignmentsCacheKey(userId: number | null, mode: MobileViewMode): string | null {
  return userId === null ? null : `${CACHE_KEY_PREFIX}:${userId}:${mode}`;
}

function readCache(cacheKey: string | null, mode: MobileViewMode): CachePayload | null {
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
      cached.mode !== mode
      || typeof cached.loadedAt !== "string"
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

function addCalendarMonths(date: Date, months: number): Date {
  const target = new Date(date);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  const lastDayOfTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDayOfTargetMonth));
  return target;
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

function formatHomeAssignmentDateLabel(date: string): string {
  return `${formatWeekday(date).replace(/\.$/, "")} · ${formatShortDate(date)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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

function formatAssignmentRange(assignment: MobileAssignment): string {
  return formatRangeLabel(assignment.start_date, assignment.end_date);
}
