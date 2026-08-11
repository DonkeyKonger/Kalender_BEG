import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EMPTY_OPERATIONAL_ABSENCE_DRAFT,
  operationalAbsencePayloadFromDraft,
} from "../src/lib/operationalAbsence.ts";

const [apiSource, dashboardSource, pickerSource, operationalAbsenceSource, styles] = await Promise.all([
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/DashboardNotePickers.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/operationalAbsence.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

function buildDraft(overrides = {}) {
  return {
    ...EMPTY_OPERATIONAL_ABSENCE_DRAFT,
    date: "2026-08-12",
    project_manager_id: "42",
    ...overrides,
  };
}

test("minimal operational absence payload keeps all optional values empty", () => {
  const result = operationalAbsencePayloadFromDraft(buildDraft());

  assert.deepEqual(result, {
    error: null,
    payload: {
      project_manager_id: 42,
      date: "2026-08-12",
      start_time: null,
      end_time: null,
      site_id: null,
      text: null,
    },
  });
});

test("full operational absence payload uses stable ids and trims optional input", () => {
  const result = operationalAbsencePayloadFromDraft(buildDraft({
    project_manager_id: " 42 ",
    start_time: "07:15",
    end_time: "12:30",
    site_id: " 8015 ",
    text: "  Übergabe an Vertretung abgestimmt.  ",
  }));

  assert.deepEqual(result, {
    error: null,
    payload: {
      project_manager_id: 42,
      date: "2026-08-12",
      start_time: "07:15",
      end_time: "12:30",
      site_id: 8015,
      text: "Übergabe an Vertretung abgestimmt.",
    },
  });
});

test("date and project manager are required", () => {
  assert.deepEqual(
    operationalAbsencePayloadFromDraft(buildDraft({ date: "" })),
    { error: "Bitte ein Datum auswählen.", payload: null },
  );
  assert.deepEqual(
    operationalAbsencePayloadFromDraft(buildDraft({ project_manager_id: "" })),
    { error: "Bitte einen Projektleiter auswählen.", payload: null },
  );
});

test("an operational absence time range must be supplied as a complete pair", () => {
  const onlyStart = operationalAbsencePayloadFromDraft(buildDraft({ start_time: "08:00" }));
  const onlyEnd = operationalAbsencePayloadFromDraft(buildDraft({ end_time: "12:00" }));

  assert.deepEqual(onlyStart, {
    error: "Bitte Start- und Endzeit vollständig angeben.",
    payload: null,
  });
  assert.deepEqual(onlyEnd, onlyStart);
});

test("an operational absence must end after it starts", () => {
  const equal = operationalAbsencePayloadFromDraft(buildDraft({
    start_time: "08:00",
    end_time: "08:00",
  }));
  const reversed = operationalAbsencePayloadFromDraft(buildDraft({
    start_time: "14:00",
    end_time: "09:00",
  }));

  assert.deepEqual(equal, {
    error: "Die Endzeit muss nach der Startzeit liegen.",
    payload: null,
  });
  assert.deepEqual(reversed, equal);
});

test("operational absence API uses dedicated range, option, create and delete endpoints", () => {
  const start = apiSource.indexOf("async operationalAbsences");
  const end = apiSource.indexOf("async persons", start);
  const contract = apiSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(contract, /new URLSearchParams\(\{\s*start: params\.startDate,\s*end: params\.endDate,/);
  assert.match(contract, /request<OperationalAbsence\[\]>\(`\/operational-absences\?\$\{search\.toString\(\)\}`\)/);
  assert.match(contract, /request<OperationalAbsenceProjectManager\[\]>\("\/operational-absences\/project-manager-options"\)/);
  assert.match(contract, /request<OperationalAbsenceSite\[\]>\("\/operational-absences\/site-options"\)/);
  assert.match(contract, /request<OperationalAbsence>\("\/operational-absences", \{[\s\S]*method: "POST",[\s\S]*body: JSON\.stringify\(payload\)/);
  assert.match(contract, /request<void>\(`\/operational-absences\/\$\{absenceId\}`, \{ method: "DELETE" \}\)/);
});

test("creating an operational absence notifies this window and already open matrix tabs", () => {
  assert.match(dashboardSource, /await api\.createOperationalAbsence\(result\.payload\);[\s\S]*publishOperationalAbsencesUpdated\(\)/);
  assert.match(operationalAbsenceSource, /window\.dispatchEvent\(new CustomEvent\(OPERATIONAL_ABSENCES_UPDATED_EVENT\)\)/);
  assert.match(operationalAbsenceSource, /window\.localStorage\.setItem\([\s\S]*OPERATIONAL_ABSENCES_UPDATED_STORAGE_KEY/);
  assert.match(operationalAbsenceSource, /window\.addEventListener\("storage", handleStorageUpdate\)/);
});

test("absence action precedes note action and both open the shared dashboard editor", () => {
  const notesCardStart = dashboardSource.indexOf('title="Notizen"');
  const notesPanelStart = dashboardSource.indexOf("<DashboardNotesPanel", notesCardStart);
  const notesCard = dashboardSource.slice(notesCardStart, notesPanelStart);
  const absenceButton = notesCard.indexOf("Abwesenheit hinzufügen");
  const noteButton = notesCard.indexOf("Notiz hinzufügen");

  assert.ok(notesCardStart >= 0 && notesPanelStart > notesCardStart);
  assert.ok(absenceButton >= 0 && noteButton > absenceButton);
  assert.match(notesCard, /className="dashboard-note-action-row"/);
  assert.doesNotMatch(notesCard, /actions=\{/);
  assert.equal(notesCard.match(/aria-controls="dashboard-note-editor"/g)?.length, 2);
  assert.match(dashboardSource, /id="dashboard-note-editor"/);
  assert.match(dashboardSource, /editorMode === "note" \? \(/);
  assert.match(dashboardSource, /editorMode === "operational_absence"/);
});

test("project manager options come from the backend and are not hardcoded", () => {
  const loadStart = dashboardSource.indexOf("async function loadOperationalAbsenceProjectManagers");
  const loadEnd = dashboardSource.indexOf("async function loadOperationalAbsenceSites", loadStart);
  const loader = dashboardSource.slice(loadStart, loadEnd);
  const pickerStart = pickerSource.indexOf("export function DashboardOperationalAbsenceProjectManagerSelect");
  const picker = pickerSource.slice(pickerStart);

  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  assert.match(loader, /api\.operationalAbsenceProjectManagers\(\)/);
  assert.match(loader, /setOperationalAbsenceProjectManagers\(projectManagers\)/);
  assert.match(picker, /people[\s\S]*\.sort\([\s\S]*\.map\(\(person\) => \(\{/);
  assert.match(picker, /value: String\(person\.id\)/);
  assert.doesNotMatch(loader, /\b(?:AB|CE|KE|TW)\b/);
  assert.doesNotMatch(picker, /\b(?:AB|CE|KE|TW)\b/);
});

test("time inputs stay paired and the separate action row adapts without widening the notes card", () => {
  assert.match(
    styles,
    /\.dashboard-operational-absence-time-range \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s,
  );
  assert.match(styles, /container-name:\s*dashboard-notes-card/);
  assert.match(
    styles,
    /@container dashboard-notes-card \(max-width: 430px\) \{[\s\S]*\.dashboard-card-notes \.dashboard-note-action-row \{[\s\S]*flex-wrap:\s*wrap/s,
  );
  assert.match(styles, /@container dashboard-notes-card \(max-width: 430px\) \{[\s\S]*\.dashboard-card-notes \.dashboard-note-add-button \{[\s\S]*flex:\s*1 1 145px[\s\S]*white-space:\s*normal/s);
});

test("notes and messages use the same title-row sizing while note actions sit below it", () => {
  assert.match(
    styles,
    /\.dashboard-card-messages \.dashboard-card-header,\s*\.dashboard-card-notes \.dashboard-card-header \{[^}]*min-height:\s*36px;[^}]*gap:\s*7px;[^}]*padding:\s*7px 10px/s,
  );
  assert.match(
    styles,
    /\.dashboard-note-action-row \{[^}]*border-bottom:\s*1px solid var\(--dashboard-section-border\);[^}]*padding:\s*6px 8px/s,
  );
});
