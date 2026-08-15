import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


const expectedAssignments = [
  ["FileText", "time", "Arbeitszeit erfassen"],
  ["UserCircle", "profile", "Persönliche Akte"],
  ["Plane", "vacation", "Urlaubsantrag"],
  ["HeartPulse", "sickness", "Krankmeldung"],
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


test("mobile quick actions keep the intended order", () => {
  const labels = [
    "Arbeitszeit erfassen",
    "Persönliche Akte",
    "Urlaubsantrag",
    "Krankmeldung",
    "Einstellungen",
  ];

  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(pageSource.indexOf(`title="${labels[index - 1]}"`) < pageSource.indexOf(`title="${labels[index]}"`));
  }
  assert.doesNotMatch(pageSource, /title="Lohnzeit erfassen"/);
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
    /@media \(max-width: 340px\) \{[\s\S]*\.mobile-home-overview-header \{[^}]*padding:\s*10px;/s,
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


test("mobile home follows the personal-file hierarchy", () => {
  assert.match(pageSource, /className="mobile-home-overview-header"[\s\S]*<h1>Meine Übersicht<\/h1>/);
  assert.match(pageSource, /className="mobile-home-overview-panel"[\s\S]*>Nächste Einsätze<\/h2>/);
  assert.match(pageSource, /className="mobile-home-timeline-track"[\s\S]*mobileHomeTimelinePages\.map\(\(page\) =>[\s\S]*page\.map\(\(item\) =>/);
  assert.doesNotMatch(pageSource, /MOBILE_HOME_VISIBLE_DAY_COUNT|\.slice\(\s*0\s*,\s*4\s*\)/);
  assert.doesNotMatch(pageSource, /mobile-home-overview-panel is-featured|mobile-home-overview-panel is-upcoming/);
  assert.match(pageSource, /<h2>Schnellzugriff<\/h2>/);
  assert.doesNotMatch(pageSource, /HardHat|mobile-home-assignment-icon/);
  assert.doesNotMatch(pageSource, /mobile-home-hero-icon/);
  assert.doesNotMatch(pageSource, /title="Alle Einsätze anzeigen"\s+text=/);
});


test("horizontal assignment timeline keeps every planned block beyond the legacy four-item limit", () => {
  assert.match(
    pageSource,
    /const nextFourteenDays = useMemo\(\(\) => getDayRange\(today, 14\), \[today\]\)/,
  );
  assert.match(
    pageSource,
    /const mobileHomeDays = useMemo\([\s\S]*?\(\) => nextFourteenDays\s*\.filter\([\s\S]*?shouldShowMobileUpcomingDay[\s\S]*?\),\s*\[dailyByDate, nextFourteenDays\]/,
  );
  assert.doesNotMatch(
    pageSource,
    /MOBILE_HOME_DAY_WINDOW|getDayRange\(today, 7\)/,
  );

  for (const plannedCount of [3, 4, 8, 12, 20]) {
    const renderedItems = Array.from({ length: plannedCount }, (_, index) => ({ id: index + 1 }));
    const pages = [];
    for (let index = 0; index < renderedItems.length; index += 2) {
      pages.push(renderedItems.slice(index, index + 2));
    }
    assert.equal(pages.flat().length, plannedCount);
  }
});


test("planned counter uses the grouped blocks rendered by the horizontal timeline", () => {
  assert.match(
    pageSource,
    /mobileHomeTimelineItems\.filter\(\(item\) => item\.assignment !== null\)\.length/,
  );
  assert.match(pageSource, /function buildMobileHomeTimelineItems\(/);
  assert.match(pageSource, /continuesPrevious[\s\S]*previous\.dayCount \+= 1/);
});


test("mobile home keeps a compact identity, status, and metadata header", () => {
  assert.match(
    pageSource,
    /className="mobile-home-overview-header"[\s\S]*className="mobile-home-identity-row"[\s\S]*user\?\.display_name[\s\S]*className="mobile-home-title-copy"[\s\S]*Aktualisiert \{formatTime\(loadedAt\)\}/,
  );
  assert.doesNotMatch(pageSource, /Persönlicher Bereich/i);
  assert.doesNotMatch(pageSource, /className="mobile-home-actions"/);
  assert.match(
    styles,
    /\.mobile-home-overview-header \{[^}]*gap:\s*8px;[^}]*border-radius:\s*16px;[^}]*background:\s*#ffffff;[^}]*padding:\s*12px;/s,
  );
  assert.match(
    styles,
    /\.app-shell\.is-mobile-workspace \.app-main:has\(\.mobile-home-overview-header\) > \.mobile-appshell-actions \{[^}]*display:\s*none;/s,
  );
});


test("manual refresh and logout reuse their existing handlers in mobile settings", () => {
  assert.match(
    pageSource,
    /className="mobile-settings-system-actions"[\s\S]*onClick=\{\(\) => void loadAssignments\(\)\}[\s\S]*Daten aktualisieren[\s\S]*onClick=\{\(\) => void handleLogout\(\)\}[\s\S]*Abmelden/,
  );
  assert.match(
    styles,
    /\.mobile-settings-system-action \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;[^}]*min-height:\s*52px;/s,
  );
});


test("the assignment timeline scales its cards and copy for narrow mobile viewports", () => {
  assert.match(
    styles,
    /\.mobile-home-timeline-date \{[^}]*width:\s*calc\(100% \+ 18px\);[^}]*clip-path:\s*polygon\(0 0, calc\(100% - 18px\) 0, 100% 50%, calc\(100% - 18px\) 100%, 0 100%\);/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-page \{[^}]*grid-auto-rows:\s*minmax\(clamp\(84px, 24vw, 98px\), auto\);[^}]*align-content:\s*start;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-card \{[^}]*grid-template-columns:\s*clamp\(92px, 27vw, 106px\) minmax\(0, 1fr\);[^}]*min-height:\s*clamp\(84px, 24vw, 98px\);[^}]*padding:\s*0;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-copy b \{[^}]*display:\s*-webkit-box;[^}]*font-size:\s*clamp\(0\.94rem, 4\.4vw, 1\.06rem\);[^}]*white-space:\s*normal;[^}]*-webkit-line-clamp:\s*2;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*\.mobile-home-timeline-page \{[^}]*grid-auto-rows:\s*minmax\(82px, auto\);[\s\S]*\.mobile-home-timeline-card \{[^}]*grid-template-columns:\s*88px minmax\(0, 1fr\);[^}]*min-height:\s*82px;[^}]*padding:\s*0;/s,
  );
});


test("assignment cards use blue next/later wedges without the construction icon", () => {
  assert.match(pageSource, /isNext=\{item\.key === mobileHomeTimelineItems\[0\]\?\.key\}/);
  assert.match(pageSource, /<em>\{isNext \? "Als nächstes" : "Danach"\}<\/em>/);
  assert.doesNotMatch(pageSource, /HardHat|mobile-home-assignment-icon/);
  assert.match(
    styles,
    /\.mobile-home-timeline-date\.is-next \{[^}]*linear-gradient\(135deg, #28639f 0%, #174a7d 100%\);[^}]*color:\s*#ffffff;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-date \{[^}]*linear-gradient\(135deg, #edf3fa 0%, #dbe7f4 100%\);/s,
  );
});


test("the home assignment block is a snap timeline with grouped consecutive assignment days", () => {
  assert.match(pageSource, /function buildMobileHomeTimelineItems\([\s\S]*latestItemByAssignmentId\.get\(daily\.assignment\.id\)[\s\S]*previous\.dayCount \+= 1/);
  assert.match(pageSource, /MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE\s*=\s*2/);
  assert.match(pageSource, /function chunkMobileHomeTimelineItems\([\s\S]*items\.slice\(index, index \+ MOBILE_HOME_TIMELINE_ITEMS_PER_PAGE\)/);
  assert.match(pageSource, /className="mobile-home-timeline-pagination"[\s\S]*scrollMobileHomeTimelineTo\(index\)/);
  assert.match(pageSource, /className="mobile-home-timeline-copy"[\s\S]*mobile-home-timeline-duration[\s\S]*\{item\.dayCount\} Einsatztage/);
  assert.match(
    styles,
    /\.mobile-home-timeline-track \{[^}]*grid-auto-columns:\s*calc\(100% - clamp\(8px, 3vw, 14px\)\);[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-inline:\s*contain;[^}]*scroll-snap-type:\s*x mandatory;[^}]*scrollbar-width:\s*none;[^}]*touch-action:\s*pan-x pan-y;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-timeline-page \{[^}]*grid-auto-rows:\s*minmax\(clamp\(84px, 24vw, 98px\), auto\);[^}]*scroll-snap-align:\s*start;[^}]*scroll-snap-stop:\s*always;/s,
  );
});


test("quick actions stay full width with compact readable sizing", () => {
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-card\.is-compact strong \{[^}]*font-size:\s*clamp\(0\.87rem, 3\.7vw, 0\.94rem\);[^}]*overflow-wrap:\s*normal;[^}]*white-space:\s*nowrap;[^}]*word-break:\s*normal;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-card \{[^}]*gap:\s*8px;[^}]*min-height:\s*56px;[^}]*padding:\s*9px;/s,
  );
  assert.match(
    styles,
    /\.mobile-home-quick-actions \.mobile-action-icon \{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*padding:\s*8px;/s,
  );
});


test("mobile home compaction uses real layout values instead of global scaling", () => {
  const mobileHomeStyles = styles.slice(
    styles.indexOf(".mobile-home-page"),
    styles.indexOf(".mobile-bottom-sheet-backdrop"),
  );

  assert.doesNotMatch(mobileHomeStyles, /\bzoom\s*:|transform\s*:\s*scale\(/);
  assert.match(styles, /\.mobile-home-quick-actions \.mobile-action-card \{[^}]*min-height:\s*56px;/s);
  assert.match(styles, /\.mobile-home-all-assignments-button \{[^}]*min-height:\s*44px;/s);
});
