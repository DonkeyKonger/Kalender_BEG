import { LogOut } from "lucide-react";
import { useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { canShowNavItem } from "../auth/permissions";
import { navigationItems } from "../config/navigation";
import { useDashboardMessageCount } from "../messages/DashboardMessageCountContext";

export function AppShell() {
  const { user, logout } = useAuth();
  const { count: dashboardMessageCount } = useDashboardMessageCount();
  const [sidebarMode, setSidebarMode] = useState<"collapsed" | "pointer" | "keyboard">("collapsed");
  const lastSidebarInputRef = useRef<"pointer" | "keyboard">("pointer");
  const visibleItems = navigationItems.filter((item) => user && canShowNavItem(user, item));

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
        {user ? (
          <div className="mobile-appshell-actions" aria-label="Mobile App-Aktionen">
            <span className="mobile-appshell-user">Angemeldet als {user?.display_name}</span>
            {user.role !== "monteur" ? (
              <button className="icon-button" type="button" onClick={() => void logout()}>
                <LogOut aria-hidden="true" size={17} />
                <span>Abmelden</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
