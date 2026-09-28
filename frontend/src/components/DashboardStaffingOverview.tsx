import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { DashboardStaffingDay } from "../lib/api";
import { matrixSiteHref } from "../lib/matrixNavigation";

const MAX_VISIBLE_ITEMS = 4;
const MAX_VISIBLE_SITES = 3;
const dayFormatter = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });

export function DashboardStaffingOverview({ days, today }: { days: DashboardStaffingDay[]; today: string }) {
  return (
    <div className="dashboard-staffing-grid" aria-label="Personalbedarf und freie Monteure für acht Wochentage">
      {days.map((day, index) => (
        <section className={`dashboard-staffing-day${day.isWorkday ? "" : " is-non-workday"}${index > 0 && new Date(`${day.date}T12:00:00`).getDay() === 1 ? " has-weekend-gap" : ""}`} key={day.date}>
          <h3><time dateTime={day.date}>{dayFormatter.format(new Date(`${day.date}T12:00:00`))}</time>{day.date === today && <span>Heute</span>}</h3>
          <div className="dashboard-staffing-needs">
            <h4>Baustellenbedarf <span>{day.needs.length}</span></h4>
            <div className="dashboard-staffing-needs-list">
              {day.needs.slice(0, MAX_VISIBLE_SITES).map((need, index) => <SiteBubble need={need} key={`${need.siteNumber}:${need.siteName}:${index}`} />)}
              {!day.needs.length && <p className="dashboard-staffing-empty">Kein offener Bedarf</p>}
            </div>
            <StaffingOverflow id={`dashboard-site-needs-${day.date}`} date={day.date} count={day.needs.length} limit={MAX_VISIBLE_SITES} label="Baustellenbedarf">
              {day.needs.map((need, index) => <SiteBubble need={need} key={`${need.siteNumber}:${need.siteName}:${index}`} />)}
            </StaffingOverflow>
          </div>
          <FreeWorkers day={day} />
        </section>
      ))}
    </div>
  );
}

function SiteBubble({ need }: { need: DashboardStaffingDay["needs"][number] }) {
  return <Link className="dashboard-staffing-site" to={matrixSiteHref(need.siteId, need.projectManagerPersonId)} title={`${need.siteNumber ?? ""} · ${need.siteName} · ${need.managerLabel}`}>
    <strong>{need.siteName}</strong>
    <span>{[need.siteNumber, need.managerLabel].filter(Boolean).join(" · ")}</span>
  </Link>;
}

function WorkerBubble({ person, fullName = false }: { person: DashboardStaffingDay["freeWorkers"][number]; fullName?: boolean }) {
  return <div className="dashboard-staffing-worker" title={`${person.display_name}${person.isExternal ? " · Extern" : ""}`}>
    <span>{fullName ? person.display_name : person.short_code || person.display_name}</span>{person.isExternal && <small>extern</small>}
  </div>;
}

function FreeWorkers({ day }: { day: DashboardStaffingDay }) {
  return <div className="dashboard-staffing-free">
    <h4>Freie Monteure {day.isWorkday && <span>{day.freeWorkers.length}</span>}</h4>
    {day.freeWorkers.slice(0, MAX_VISIBLE_ITEMS).map(person => <WorkerBubble key={person.id} person={person} />)}
    {!day.freeWorkers.length && <p className="dashboard-staffing-empty">{day.isWorkday ? "Keine freien Monteure" : day.nonWorkdayLabel}</p>}
    <StaffingOverflow id={`dashboard-free-workers-${day.date}`} date={day.date} count={day.freeWorkers.length} label="Freie Monteure" preferAbove>
      {day.freeWorkers.map(person => <WorkerBubble key={person.id} person={person} fullName />)}
    </StaffingOverflow>
  </div>;
}

function StaffingOverflow({ id: popupId, date, count, label, children, limit = MAX_VISIBLE_ITEMS, preferAbove = false }: {
  id: string; date: string; count: number; label: string; children: ReactNode; limit?: number; preferAbove?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setAnchor(null), 200); };
  const open = () => { cancelClose(); setAnchor(triggerRef.current?.getBoundingClientRect() ?? null); };

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    if (!anchor || !popupRef.current) return;
    const bounds = popupRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: preferAbove && anchor.top - bounds.height - 6 >= 8
        ? anchor.top - bounds.height - 6
        : anchor.bottom + bounds.height + 6 <= window.innerHeight - 8
        ? anchor.bottom + 6 : Math.max(8, anchor.top - bounds.height - 6),
    });
  }, [anchor, preferAbove, count]);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !popupRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && popupRef.current?.contains(event.target))) close(); };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor]);

  if (count <= limit) return null;
  return <>
    <button
      type="button" ref={triggerRef} className="dashboard-staffing-more"
      aria-expanded={!!anchor} aria-controls={anchor ? popupId : undefined} aria-haspopup="dialog"
      onMouseEnter={open} onMouseLeave={scheduleClose} onFocus={open} onBlur={scheduleClose} onClick={open}
    >+{count - limit} mehr</button>
    {anchor && createPortal(<div
      ref={popupRef} id={popupId} role="dialog" aria-label={`${label} am ${dayFormatter.format(new Date(`${date}T12:00:00`))}`}
      className="dashboard-staffing-popover" style={position}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
    >
      <strong>{label}: {count} · {dayFormatter.format(new Date(`${date}T12:00:00`))}</strong>
      <div className="dashboard-staffing-popover-list" tabIndex={0} onFocus={cancelClose} onBlur={scheduleClose}>
        {children}
      </div>
    </div>, document.body)}
  </>;
}
