import { ClipboardList, Clock, FileText, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { DashboardMessage } from "../lib/api";
import "./DashboardMessageCard.css";

export function DashboardMessageCard({ message, busy, onOpenNote, onOpenToolIssue, onDismiss }: {
  message: DashboardMessage;
  busy: boolean;
  onOpenNote: (message: DashboardMessage) => void;
  onOpenToolIssue: (message: DashboardMessage) => void;
  onDismiss: (message: DashboardMessage) => void;
}) {
  const isNote = message.message_type === "dashboard_note_shared";
  const isTool = message.message_type === "tool_issue_reported";
  const isSigned = message.message_type === "measurement_customer_signed";
  const Icon = isNote ? ClipboardList : isTool ? Wrench : FileText;
  const status = isNote ? "Geteilt" : isTool ? "Gemeldet" : isSigned ? "Unterschrieben" : "Eingereicht";
  const person = isSigned ? message.customer_signature_name ?? "Kundenunterschrift" : message.submitted_by_name;
  const context = [person, message.site_number].filter(Boolean).join(" · ");
  const eventAt = isNote
    ? message.note_created_at ?? message.submitted_at
    : message.event_at ?? message.customer_signed_at ?? message.submitted_at;
  const preview = message.note_preview ?? message.message_text;
  const content = <>
    <span className="dashboard-message-card-heading">
      <Icon size={17} aria-hidden="true" />
      <strong>{message.title}</strong>
      <span className="dashboard-message-card-status">{status}</span>
    </span>
    <span className="dashboard-message-card-body">
      {message.site_name ? <strong>{message.site_name}</strong> : isNote ? <strong>Allgemeine Notiz</strong> : null}
      {context ? <span>{context}</span> : null}
      {preview ? <span className="dashboard-message-card-preview">{preview}</span> : null}
      {isNote && message.note_due_date ? <span>Fällig {message.note_due_date.split("-").reverse().join(".")}</span> : null}
    </span>
  </>;
  const target = message.site_id === null ? "/" : `/sites/${message.site_id}?tab=${message.message_type === "extra_work_submitted"
    ? "extra-work" : "measurement&measurementSubtab=review"}`;

  return <article className="dashboard-message-card">
    {isNote || isTool ? <button type="button" className="dashboard-message-card-open" disabled={busy}
      onClick={() => isNote ? onOpenNote(message) : onOpenToolIssue(message)}>{content}</button>
      : <Link className="dashboard-message-card-open" to={target}>{content}</Link>}
    <footer className="dashboard-message-card-footer">
      <span className="dashboard-message-card-date">
        <Clock size={14} aria-hidden="true" />
        {eventAt ? <time dateTime={eventAt}>{new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(eventAt))}</time>
          : <span>Zeitpunkt unbekannt</span>}
      </span>
      <button type="button" className="dashboard-message-card-read" disabled={busy}
        aria-label={isTool ? "Werkzeugmeldung als erledigt markieren" : "Meldung als gelesen markieren"}
        onClick={() => onDismiss(message)}>
        {isTool ? "Als erledigt markieren" : "Als gelesen markieren"}
      </button>
    </footer>
  </article>;
}
