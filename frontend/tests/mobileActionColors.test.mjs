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
  ["UserCircle", "profile", "Persönliche Akte"],
  ["Settings", "settings", "Einstellungen"],
];

const expectedTones = ["time", "vacation", "sickness", "deployments", "profile", "settings"];


test("mobile home actions use the semantic color variants", () => {
  for (const [icon, tone, title] of expectedAssignments) {
    const actionPattern = new RegExp(
      `<PlaceholderAction[\\s\\S]*?icon=\\{${icon}\\}[\\s\\S]*?tone="${tone}"[\\s\\S]*?title="${title}"`,
    );
    assert.match(pageSource, actionPattern);
  }

  assert.match(pageSource, /mobile-action-card mobile-action-card--\$\{tone\}/);
});


test("mobile action colors are centralized as semantic design tokens", () => {
  for (const tone of expectedTones) {
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
    /\.mobile-home-page \{[^}]*padding-bottom:\s*calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\);[^}]*overflow:\s*visible;/s,
  );
  assert.match(
    styles,
    /\.mobile-action-list \{[^}]*padding-bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\);/s,
  );
  assert.match(
    styles,
    /\.mobile-home-quick-actions \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s,
  );
  assert.match(
    styles,
    /\.mobile-home-secondary-actions \{[^}]*padding-bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\);/s,
  );
});


test("mobile home stays compact across phone and tablet viewports", () => {
  assert.match(
    styles,
    /\.mobile-home-page \{[^}]*width:\s*min\(100%, 560px\);[^}]*max-width:\s*560px;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*\.mobile-home-overview-header \{[^}]*padding:\s*12px;/s,
  );
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.app-main \{[^}]*min-height:\s*100dvh;/s,
  );
});


test("mobile home actions keep the established destinations and compact copy", () => {
  assert.match(pageSource, /className="mobile-home-all-assignments-button"[\s\S]*title="Alle Einsätze anzeigen"[\s\S]*onClick=\{\(\) => setActiveScreen\("assignments"\)\}/);
  assert.match(pageSource, /title="Persönliche Akte"\s+text="Urlaub, Kranktage, Fahrzeug und Werkzeuge anzeigen\."\s+onOpen=\{\(\) => navigate\("\/me\/personal-file"\)\}/);
  assert.match(pageSource, /title="Einstellungen"\s+text="App-Einstellungen und persönliche Optionen\."\s+onOpen=\{\(\) => setActiveScreen\("settings"\)\}/);
});


test("mobile home follows the personal-file hierarchy and uses a construction icon", () => {
  assert.match(pageSource, /className="mobile-home-overview-header"[\s\S]*<h1>Meine Übersicht<\/h1>/);
  assert.match(pageSource, /className="mobile-home-overview-panel"[\s\S]*>Nächste Einsätze<\/h2>/);
  assert.match(pageSource, /className="mobile-home-timeline-track"[\s\S]*mobileHomeTimelinePages\.map\(\(page\) =>[\s\S]*page\.map\(\(item\) =>/);
  assert.doesNotMatch(pageSource, /mobileHomeDays\.slice\(/);
  assert.doesNotMatch(pageSource, /mobile-home-overview-panel is-featured|mobile-home-overview-panel is-upcoming/);
  assert.match(pageSource, /<h2>Schnellzugriff<\/h2>/);
  assert.equal(pageSource.match(/<HardHat size=\{22\}/g)?.length, 1);
  assert.doesNotMatch(pageSource, /mobile-home-hero-icon/);
  assert.doesNotMatch(pageSource, /title="Alle Einsätze anzeigen"\s+text=/);
});


test("mobile home groups identity, status, metadata, and actions in one rounded header", () => {
  assert.match(
    pageSource,
    /className="mobile-home-overview-header"[\s\S]*className="mobile-home-identity-row"[\s\S]*user\?\.display_name[\s\S]*className="mobile-home-title-copy"[\s\S]*Aktualisiert \{formatTime\(loadedAt\)\}[\s\S]*className="mobile-home-actions"/,
  );
  assert.doesNotMatch(pageSource, /Persönlicher Bereich/i);
  assert.match(
    styles,
    /\.mobile-home-overview-header \{[^}]*border-radius:\s*16px;[^}]*background:\s*#ffffff;[^}]*padding:\s*14px;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-actions \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.app-main:has\(\.mobile-home-overview-header\) > \.mobile-appshell-actions \{[^}]*display:\s*none;/s,
  );
});


test("the assignment timeline scales its cards and copy for narrow mobile viewports", () => {
  assert.match(
    styles,
    /\.mobile-home-overview-panel \.mobile-home-assignment-icon \{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*border-radius:\s*12px;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-page \{[^}]*grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*min-height:\s*clamp\(148px, 42vw, 174px\);/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-card \{[^}]*grid-template-columns:\s*minmax\(clamp\(66px, 20vw, 86px\), auto\) minmax\(0, 1fr\);[^}]*min-height:\s*0;[^}]*padding:\s*clamp\(7px, 2\.4vw, 10px\);/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-copy b \{[^}]*font-size:\s*clamp\(0\.82rem, 4vw, 0\.98rem\);/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*\.mobile-home-timeline-page \{[^}]*min-height:\s*152px;[\s\S]*\.mobile-home-timeline-card \{[^}]*grid-template-columns:\s*minmax\(60px, 68px\) minmax\(0, 1fr\);[^}]*min-height:\s*0;[^}]*padding:\s*6px 7px;/s,
  );
});


test("the home assignment block is a snap timeline with grouped consecutive assignment days", () => {
  assert.match(pageSource, /function buildMobileHomeTimelineItems\([\s\S]*latestItemByAssignmentId\.get\(daily\.assignment\.id\)[\s\S]*previous\.dayCount \+= 1/);
  assert.match(pageSource, /MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE\s*=\s*2/);
  assert.match(pageSource, /function chunkMobileHomeTimelineItems\([\s\S]*items\.slice\(index, index \+ MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE\)/);
  assert.match(pageSource, /className="mobile-home-timeline-pagination"[\s\S]*scrollMobileHomeTimelineTo\(index\)/);
  assert.match(
    styles,
    /\.mobile-home-timeline-track \{[^}]*grid-auto-columns:\s*calc\(100% - clamp\(24px, 8vw, 42px\)\);[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-inline:\s*contain;[^}]*scroll-snap-type:\s*x mandatory;[^}]*scrollbar-width:\s*none;[^}]*touch-action:\s*pan-x pan-y;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-page \{[^}]*grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*scroll-snap-align:\s*start;[^}]*scroll-snap-stop:\s*always;/s,
  );
});


test("quick actions stack at full width with restored readable sizing", () => {
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-card\.is-compact strong \{[^}]*font-size:\s*clamp\(0\.92rem, 4vw, 1rem\);[^}]*overflow-wrap:\s*normal;[^}]*white-space:\s*nowrap;[^}]*word-break:\s*normal;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-card \{[^}]*gap:\s*10px;[^}]*min-height:\s*68px;[^}]*padding:\s*12px;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-icon \{[^}]*width:\s*34px;[^}]*height:\s*34px;[^}]*padding:\s*9px;/s,
  );
});
