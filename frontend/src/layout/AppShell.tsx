import { LogOut } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { navigationItems } from "../config/navigation";

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const visibleItems = navigationItems.filter((item) => user && item.roles.includes(user.role));
  const showUserTopbar = location.pathname === "/";
  const showProjectManagerMobileLogout = showUserTopbar && user?.role === "project_manager";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Hauptnavigation">
        <div className="brand-block">
          <span className="brand-mark brand-logo-mark">
            <img src="/beg-logo.png" alt="BEG Logo" />
          </span>
          <div className="brand-copy">
            <p className="brand-name">Kalender Baustellen</p>
            <p className="brand-subtitle">Einsatzplanung</p>
          </div>
        </div>

        <nav className="nav-list">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.path} to={item.path} end={item.path === "/"}>
                <Icon aria-hidden="true" size={20} />
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

        {showProjectManagerMobileLogout ? (
          <div className="mobile-appshell-actions" aria-label="Mobile Projektleiteraktionen">
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
