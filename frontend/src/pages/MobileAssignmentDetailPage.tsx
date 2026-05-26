import {
  ArrowLeft,
  CalendarClock,
  ClipboardList,
  FolderOpen,
  Hammer,
  MapPin,
  Package,
  ReceiptText,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { SiteStatusBadge } from "../components/StatusBadge";
import type { MobileAssignment, MobileAssignmentsResponse } from "../types/mobile";

const CACHE_KEY = "kb_mobile_assignments_cache_v1";

type MobileDetailTab = "overview" | "time" | "folders" | "measurement" | "tools";

type LocationState = {
  assignment?: MobileAssignment;
};

const detailTabs: Array<{ key: MobileDetailTab; label: string; icon: typeof ClipboardList }> = [
  { key: "overview", label: "Übersicht", icon: ClipboardList },
  { key: "time", label: "Lohnerfassung", icon: CalendarClock },
  { key: "folders", label: "Ordnerstruktur", icon: FolderOpen },
  { key: "measurement", label: "Aufmaß", icon: ReceiptText },
  { key: "tools", label: "Werkzeuge & Material", icon: Package },
];

export function MobileAssignmentDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { assignmentId } = useParams();
  const [activeTab, setActiveTab] = useState<MobileDetailTab>("overview");

  const assignment = useMemo(() => {
    const stateAssignment = (location.state as LocationState | null)?.assignment;
    if (stateAssignment) {
      return stateAssignment;
    }
    return findCachedAssignment(assignmentId);
  }, [assignmentId, location.state]);

  if (!assignment) {
    return (
      <section className="mobile-page mobile-detail-page">
        <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
          <ArrowLeft aria-hidden="true" size={17} />
          <span>Zurück</span>
        </button>
        <div className="empty-panel">Dieser Einsatz konnte nicht aus dem lokalen Verlauf geladen werden.</div>
      </section>
    );
  }

  return (
    <section className="mobile-page mobile-detail-page">
      <button className="icon-button secondary mobile-back-button" type="button" onClick={() => navigate("/me/assignments")}>
        <ArrowLeft aria-hidden="true" size={17} />
        <span>Zurück</span>
      </button>

      <header className="mobile-detail-hero assignment-card">
        <div className="assignment-card-main">
          <div>
            <p className="eyebrow">Baustelle</p>
            <h1>{assignment.site.name}</h1>
            <p className="muted-text">{[assignment.site.site_number, assignment.site.customer].filter(Boolean).join(" · ")}</p>
          </div>
          <SiteStatusBadge status={assignment.site.status} />
        </div>
        <p className="assignment-date"><CalendarClock aria-hidden="true" size={15} />{formatAssignmentRange(assignment)}</p>
      </header>

      <nav className="mobile-detail-tabs" aria-label="Baustellendetails">
        {detailTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              className={activeTab === tab.key ? "active" : ""}
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon aria-hidden="true" size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {activeTab === "overview" && <OverviewPanel assignment={assignment} />}
      {activeTab === "time" && <PlaceholderPanel icon={CalendarClock} text="Lohnerfassung wird vorbereitet." />}
      {activeTab === "folders" && <PlaceholderPanel icon={FolderOpen} text="Ordnerstruktur wird vorbereitet." />}
      {activeTab === "measurement" && <PlaceholderPanel icon={ReceiptText} text="Aufmaß wird vorbereitet." />}
      {activeTab === "tools" && <PlaceholderPanel icon={Hammer} text="Werkzeuge & Material wird vorbereitet." />}
    </section>
  );
}

function OverviewPanel({ assignment }: { assignment: MobileAssignment }) {
  return (
    <div className="mobile-detail-panel">
      <h2>Übersicht</h2>
      <div className="assignment-detail-list">
        {(assignment.site.location || assignment.site.address) && (
          <p><MapPin aria-hidden="true" size={16} /><span>{[assignment.site.location, assignment.site.address].filter(Boolean).join(" - ")}</span></p>
        )}
        {assignment.site.project_manager && (
          <p><UserRound aria-hidden="true" size={16} /><span>{assignment.site.project_manager.display_name}</span></p>
        )}
        {assignment.site.customer && (
          <p><ClipboardList aria-hidden="true" size={16} /><span>Kunde: {assignment.site.customer}</span></p>
        )}
      </div>
      {assignment.site.info && <p className="assignment-note">{assignment.site.info}</p>}
      {assignment.note && <p className="assignment-note">{assignment.note}</p>}
    </div>
  );
}

function PlaceholderPanel({ icon: Icon, text }: { icon: typeof ClipboardList; text: string }) {
  return (
    <div className="mobile-detail-panel mobile-placeholder-panel">
      <Icon aria-hidden="true" size={22} />
      <p>{text}</p>
    </div>
  );
}

function findCachedAssignment(assignmentId: string | undefined): MobileAssignment | null {
  if (!assignmentId) {
    return null;
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const cache = JSON.parse(raw) as { data?: MobileAssignmentsResponse };
    return cache.data?.assignments.find((item) => String(item.id) === assignmentId) ?? null;
  } catch {
    return null;
  }
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function formatRangeLabel(start: string, end: string): string {
  return `${formatDate(start)} bis ${formatDate(end)}`;
}

function formatAssignmentRange(assignment: MobileAssignment): string {
  return assignment.start_date === assignment.end_date
    ? formatDate(assignment.start_date)
    : formatRangeLabel(assignment.start_date, assignment.end_date);
}
