import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("location review picker keeps keyboard selection separate from saving", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const saveStart = source.indexOf("async function saveLocationReviewSite");
  const keyboardStart = source.indexOf("function handleLocationReviewPickerKeyDown");
  const keyboardEnd = source.indexOf("async function createTimeEntryForMissingDay", keyboardStart);
  const keyboard = source.slice(keyboardStart, keyboardEnd);

  assert.match(source, /const \[locationReviewActiveSiteId, setLocationReviewActiveSiteId\] = useState\(""\)/);
  assert.match(source, /const locationReviewActiveSiteOptions = useMemo\([\s\S]*?locationReviewSiteSearch\.trim\(\) \? locationReviewSiteSearchResults : locationReviewSiteOptions/s);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(keyboard, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"[\s\S]*?moveLocationReviewActiveSite/s);
  assert.match(keyboard, /event\.key === "Enter"[\s\S]*?event\.preventDefault\(\);[\s\S]*?selectActiveLocationReviewSite\(\)/s);
  assert.match(source, /function selectActiveLocationReviewSite\(\): void \{[\s\S]*?selectLocationReviewSite\([\s\S]*?closeLocationReviewPicker\(\);/s);
  assert.doesNotMatch(keyboard, /saveLocationReviewSite/);
  assert.match(keyboard, /event\.key === "Escape"[\s\S]*?closeLocationReviewPicker\(\)/s);
  assert.ok(saveStart > keyboardEnd);
});

test("location review picker exposes combobox and listbox state to assistive technology", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /aria-activedescendant=\{locationReviewActiveOptionId\}[\s\S]*?aria-controls=\{locationReviewActiveListboxId\}[\s\S]*?role="combobox"/s);
  assert.match(source, /id="time-review-location-search-results"[\s\S]*?role="listbox"[\s\S]*?tabIndex=\{0\}[\s\S]*?onKeyDown=\{handleLocationReviewPickerKeyDown\}/s);
  assert.match(source, /id="time-review-location-all-options"[\s\S]*?role="listbox"[\s\S]*?tabIndex=\{0\}[\s\S]*?onKeyDown=\{handleLocationReviewPickerKeyDown\}/s);
  assert.match(source, /role="option"[\s\S]*?aria-selected=\{String\(site\.id\) === locationReviewSiteId\}[\s\S]*?onClick=\{\(\) => selectLocationReviewSite\(String\(site\.id\)/s);
  assert.match(styles, /\.time-review-location-option\.is-active\s*\{[^}]*box-shadow:\s*inset 3px 0 #1763c5;/s);
});

test("location review title and actions match the manual time dialog hierarchy", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const locationDialogStart = source.indexOf("{locationReviewDiagnosticEntry && (");
  const locationDialog = source.slice(locationDialogStart);

  assert.match(locationDialog, /<span>Lohnprüfung<\/span>\s*<h4>Ort manuell korrigieren – \{formatTimeEntryRange\(locationReviewDiagnosticEntry\)\}<\/h4>/);
  assert.match(source, /return `\$\{formatTimeEntryClock\(entry\.start_time\)\}–\$\{formatTimeEntryClock\(entry\.end_time\)\}`;/);
  assert.match(locationDialog, /className="icon-button secondary time-review-diagnostic-cancel"[\s\S]*?disabled=\{isSavingLocationReview\}[\s\S]*?onClick=\{closeLocationReviewDiagnostic\}[\s\S]*?>\s*Abbrechen\s*<\/button>[\s\S]*?className="icon-button time-review-diagnostic-save"/);
  assert.match(locationDialog, /className="icon-button time-review-diagnostic-save"/);
  assert.doesNotMatch(locationDialog, /className="icon-button secondary time-review-diagnostic-save"/);
});
