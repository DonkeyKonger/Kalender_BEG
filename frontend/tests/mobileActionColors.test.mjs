import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


const expectedAssignments = [
  ["FileText", "time", "Lohnzeit erfassen"],
  ["Plane", "vacation", "Urlaubsantrag"],
  ["HeartPulse", "sickness", "Krankmeldung"],
  ["CalendarClock", "deployments", "Alle Einsätze anzeigen"],
  ["UserCircle", "profile", "Persönliche Akte"],
  ["Settings", "settings", "Einstellungen"],
];


test("mobile home actions use the semantic color variants", () => {
  for (const [icon, tone, title] of expectedAssignments) {
    const actionPattern = new RegExp(
      `<PlaceholderAction\\s+icon=\\{${icon}\\}\\s+tone="${tone}"\\s+title="${title}"`,
    );
    assert.match(pageSource, actionPattern);
  }

  assert.match(pageSource, /mobile-action-card mobile-action-card--\$\{tone\}/);
});


test("mobile action colors are centralized as semantic design tokens", () => {
  for (const [, tone] of expectedAssignments) {
    assert.match(styles, new RegExp(`--mobile-action-${tone}-icon:`));
    assert.match(styles, new RegExp(`--mobile-action-${tone}-background:`));
    assert.match(styles, new RegExp(`--mobile-action-${tone}-border:`));
    assert.match(styles, new RegExp(`--mobile-action-${tone}-focus:`));
  }

  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.mobile-action-card \.mobile-action-icon \{[^}]*background:\s*var\(--mobile-action-background\);[^}]*color:\s*var\(--mobile-action-icon\);/s,
  );
});


test("disabled mobile actions stay neutral and interaction states keep their accent", () => {
  assert.match(pageSource, /disabled=\{disabled\}/);
  assert.match(pageSource, /className="mobile-action-icon"/);
  assert.match(pageSource, /className="mobile-action-chevron"/);
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.mobile-action-card:focus-visible:not\(:disabled\) \{[^}]*outline:\s*3px solid var\(--mobile-action-focus\);[^}]*transform:\s*none;/s,
  );
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.mobile-action-card:active:not\(:disabled\) \{[^}]*transform:\s*none;/s,
  );
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.mobile-action-card:disabled \.mobile-action-icon \{[^}]*background:\s*#edf0f3;[^}]*color:\s*#8b96a3;/s,
  );
});


test("mobile home keeps every action reachable below browser safe areas", () => {
  assert.match(
    styles,
    /\.mobile-home-page \{[^}]*padding-bottom:\s*calc\(118px \+ env\(safe-area-inset-bottom, 0px\)\);[^}]*overflow:\s*visible;/s,
  );
  assert.match(
    styles,
    /\.mobile-action-list \{[^}]*padding-bottom:\s*calc\(22px \+ env\(safe-area-inset-bottom, 0px\)\);/s,
  );
  assert.doesNotMatch(
    styles,
    /\.app-shell\.is-mobile-workspace \.mobile-action-list,[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
  );
});
