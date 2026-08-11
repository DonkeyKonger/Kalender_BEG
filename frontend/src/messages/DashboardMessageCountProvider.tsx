import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useAuth } from "../auth/AuthContext";
import { canAccessMainPage } from "../auth/permissions";
import { api } from "../lib/api";
import type { UserRole } from "../types/auth";
import { DashboardMessageCountContext } from "./DashboardMessageCountContext";

const DASHBOARD_MESSAGE_COUNT_POLL_INTERVAL_MS = 5_000;
const DASHBOARD_MESSAGE_ROLES: UserRole[] = ["admin", "project_manager", "office"];

type DashboardMessageCountState = {
  userId: number | null;
  count: number;
};

export function DashboardMessageCountProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<DashboardMessageCountState>({ userId: null, count: 0 });
  const refreshRef = useRef<() => void>(() => undefined);
  const enabled = Boolean(
    user
    && DASHBOARD_MESSAGE_ROLES.includes(user.role)
    && (canAccessMainPage(user, "overview") || canAccessMainPage(user, "miscellaneous")),
  );
  const userId = enabled ? user?.id ?? null : null;

  useEffect(() => {
    if (userId === null) {
      refreshRef.current = () => undefined;
      setState((current) => (
        current.userId === null && current.count === 0
          ? current
          : { userId: null, count: 0 }
      ));
      return undefined;
    }

    let active = true;
    let requestInFlight = false;
    let refreshQueued = false;

    async function loadCount(queueWhenBusy: boolean): Promise<void> {
      if (!active || document.visibilityState === "hidden") {
        return;
      }
      if (requestInFlight) {
        refreshQueued = refreshQueued || queueWhenBusy;
        return;
      }

      requestInFlight = true;
      try {
        const result = await api.dashboardMessageUnreadCount();
        if (active) {
          setState((current) => (
            current.userId === userId && current.count === result.count
              ? current
              : { userId, count: result.count }
          ));
        }
      } catch {
        // Keep the last known count. The next interval/focus refresh retries silently.
      } finally {
        requestInFlight = false;
        if (active && refreshQueued) {
          refreshQueued = false;
          void loadCount(false);
        }
      }
    }

    refreshRef.current = () => {
      void loadCount(true);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadCount(false);
      }
    };
    const handleWindowFocus = () => {
      void loadCount(false);
    };

    void loadCount(false);
    const intervalId = window.setInterval(() => {
      void loadCount(false);
    }, DASHBOARD_MESSAGE_COUNT_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      active = false;
      refreshRef.current = () => undefined;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [userId]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);
  const initialized = state.userId === userId;
  const count = initialized ? state.count : 0;
  const value = useMemo(
    () => ({ count, initialized, refresh }),
    [count, initialized, refresh],
  );

  return (
    <DashboardMessageCountContext.Provider value={value}>
      {children}
    </DashboardMessageCountContext.Provider>
  );
}
