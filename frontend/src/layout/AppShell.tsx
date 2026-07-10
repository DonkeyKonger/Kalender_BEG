import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { canAccessMainPage, canShowNavItem } from "../auth/permissions";
import { navigationItems } from "../config/navigation";
import { api } from "../lib/api";
import type { UserRole } from "../types/auth";
import type { MeasurementDashboardSubmission } from "../types/site";

const DASHBOARD_MESSAGES_POLL_INTERVAL_MS = 60_000;
const DASHBOARD_MESSAGES_EVENT_LIMIT = 6;
const DASHBOARD_MESSAGES_UPDATED_EVENT = "dashboard-messages-updated";
const DASHBOARD_MESSAGE_ROLES: UserRole[] = ["admin", "project_manager", "office"];

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [sidebarMode, setSidebarMode] = useState<"collapsed" | "pointer" | "keyboard">("collapsed");
  const [dashboardMessageCount, setDashboardMessageCount] = useState(0);
  const lastSidebarInputRef = useRef<"pointer" | "keyboard">("pointer");
  const lastDashboardMessageCountRef = useRef<number | null>(null);
  const lastDashboardMessageSignatureRef = useRef<string | null>(null);
  const visibleItems = navigationItems.filter((item) => user && canShowNavItem(user, item));
  const showUserTopbar = location.pathname === "/";

  useEffect(() => {
    if (!user || !DASHBOARD_MESSAGE_ROLES.includes(user.role) || !canAccessMainPage(user, "overview")) {
      lastDashboardMessageCountRef.current = null;
      lastDashboardMessageSignatureRef.current = null;
      setDashboardMessageCount((current) => (current === 0 ? current : 0));
      return undefined;
    }

    let active = true;
    let requestInFlight = false;

    async function pollDashboardMessages() {
      if (requestInFlight || document.visibilityState === "hidden") {
        return;
      }
      requestInFlight = true;
      try {
        const summary = await api.dashboardMessagesSummary({
          limit: DASHBOARD_MESSAGES_EVENT_LIMIT,
        });
        if (active) {
          const previewMessages = summary.latest_messages;
          const previewSignature = dashboardMessagesSignature(previewMessages);
          if (lastDashboardMessageCountRef.current !== summary.open_count) {
            lastDashboardMessageCountRef.current = summary.open_count;
            setDashboardMessageCount(summary.open_count);
          }
          if (lastDashboardMessageSignatureRef.current !== previewSignature) {
            lastDashboardMessageSignatureRef.current = previewSignature;
            window.dispatchEvent(
              new CustomEvent(DASHBOARD_MESSAGES_UPDATED_EVENT, {
                detail: previewMessages,
              }),
            );
          }
        }
      } catch (pollError) {
        if (active) {
          console.warn("Dashboard message badge polling failed", pollError);
        }
      } finally {
        requestInFlight = false;
      }
    }

    void pollDashboardMessages();
    const intervalId = window.setInterval(() => {
      void pollDashboardMessages();
    }, DASHBOARD_MESSAGES_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void pollDashboardMessages();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [user?.id, user?.role, user?.office_page_permissions]);

  function handleSidebarPointerEnter() {
    lastSidebarInputRef.current = "pointer";
    setSidebarMode("pointer");
  }

  function handleSidebarPointerDown() {
    lastSidebarInputRef.current = "pointer";
  }

  function handleSidebarPointerLeave(event: PointerEvent<HTMLElement>) {
    setSidebarMode("collapsed");

    const activeElement = document.activeElement;
    if (
      lastSidebarInputRef.current === "pointer" &&
      activeElement instanceof HTMLElement &&
      event.currentTarget.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }

  function handleSidebarKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Tab") {
      lastSidebarInputRef.current = "keyboard";
      setSidebarMode("keyboard");
    }
  }

  function handleSidebarFocus(event: FocusEvent<HTMLElement>) {
    if (lastSidebarInputRef.current === "keyboard" || !event.currentTarget.matches(":hover")) {
      setSidebarMode("keyboard");
    }
  }

  function handleSidebarBlur(event: FocusEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setSidebarMode("collapsed");
    }
  }

  const sidebarClassName = [
    "sidebar",
    sidebarMode === "pointer" ? "is-pointer-expanded" : "",
    sidebarMode === "keyboard" ? "is-keyboard-expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const appShellClassName = [
    "app-shell",
    user?.role === "monteur" ? "is-mobile-workspace" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appShellClassName}>
      <aside
        className={sidebarClassName}
        aria-label="Hauptnavigation"
        onBlur={handleSidebarBlur}
        onFocus={handleSidebarFocus}
        onKeyDown={handleSidebarKeyDown}
        onPointerDown={handleSidebarPointerDown}
        onPointerEnter={handleSidebarPointerEnter}
        onPointerLeave={handleSidebarPointerLeave}
      >
        <div className="sidebar-brand-header">
          <div className="brand-block">
            <span className="brand-mark brand-logo-mark">
              <img src="/beg-logo.png" alt="BEG Logo" />
            </span>
            <div className="brand-copy">
              <p className="brand-name">Kalender Baustellen</p>
              <p className="brand-subtitle">Einsatzplanung</p>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-logout-button"
            title="Abmelden"
            aria-label="Abmelden"
            onClick={() => void logout()}
          >
            <LogOut aria-hidden="true" size={18} />
            <span className="sidebar-logout-label">Abmelden</span>
          </button>
        </div>

        <nav className="nav-list">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const showDashboardMessageBadge = item.path === "/" && dashboardMessageCount > 0;
            return (
              <NavLink key={item.path} to={item.path} end={item.path === "/"}>
                <Icon aria-hidden="true" size={20} />
                {showDashboardMessageBadge ? (
                  <span className="nav-notification-badge" aria-label={`${dashboardMessageCount} offene Meldungen`}>
                    {dashboardMessageCount}
                  </span>
                ) : null}
                <span className="nav-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <div className="app-main">
        {showUserTopbar ? (
          <header className="topbar">
            <div>
              <p className="topbar-label">Angemeldet als</p>
              <p className="topbar-user">{user?.display_name}</p>
            </div>
            <button className="icon-button" type="button" onClick={() => void logout()}>
              <LogOut aria-hidden="true" size={18} />
              <span>Abmelden</span>
            </button>
          </header>
        ) : null}

        {user ? (
          <div className="mobile-appshell-actions" aria-label="Mobile App-Aktionen">
            <span className="mobile-appshell-user">Angemeldet als {user?.display_name}</span>
            <button className="icon-button" type="button" onClick={() => void logout()}>
              <LogOut aria-hidden="true" size={17} />
              <span>Abmelden</span>
            </button>
          </div>
        ) : null}

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
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
