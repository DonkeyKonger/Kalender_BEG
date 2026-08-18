import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [scrollSource, assignmentsSource, personalFileSource, timeEntrySource] = await Promise.all([
  readFile(new URL("../src/lib/mobileScroll.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8"),
]);


test("mobile scroll reset targets the app containers and the document scroll element", () => {
  assert.match(scrollSource, /\.app-shell\.is-mobile-workspace \.content-area/);
  assert.match(scrollSource, /\.app-shell\.is-mobile-workspace \.app-main/);
  assert.match(scrollSource, /document\.scrollingElement/);
  assert.match(scrollSource, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
});


test("mobile scroll reset uses one frame sync and no timeout polling", () => {
  assert.match(scrollSource, /window\.requestAnimationFrame\(resetMobileScrollPosition\)/);
  assert.match(scrollSource, /window\.cancelAnimationFrame\(frameId\)/);
  assert.doesNotMatch(scrollSource, /setTimeout/);
  assert.doesNotMatch(scrollSource, /setInterval/);
});


test("mobile subpages reset scroll when entering the subpage or assignment-site detail", () => {
  assert.match(assignmentsSource, /useMobileScrollReset\([\s\S]*selectedAssignmentSite\?\.site\.id[\s\S]*activeScreen !== "home"/);
  assert.match(assignmentsSource, /title="Alle Einsätze anzeigen"[\s\S]*setActiveScreen\("assignments"\)/);
  assert.match(assignmentsSource, /title="Einstellungen"[\s\S]*setActiveScreen\("settings"\)/);
  assert.match(personalFileSource, /useMobileScrollReset\("personal-file"\)/);
  assert.match(personalFileSource, /useMobileScrollReset\("personal-file-tools"\)/);
  assert.match(timeEntrySource, /useMobileScrollReset\("time-entry"\)/);
});
