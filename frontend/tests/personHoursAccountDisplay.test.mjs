import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("weekly hours log separates weighted actual, weekly deviation and overtime deduction", async () => {
  const source = await readFile(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const weeklyDeviationMinutes = entry\.weekly_actual_minutes - entry\.weekly_required_minutes;/,
  );
  assert.match(
    source,
    /Ist \$\{formatHoursAccountMinutesUnsigned\(entry\.weekly_actual_minutes\)\} \/ Soll/,
  );
  assert.match(source, /Tatsächlich gearbeitet/);
  assert.match(source, /Fehlzeit Überstunden/);
  assert.match(source, /Überstundenabbau/);
  assert.doesNotMatch(source, /entry\.weekly_required_minutes \+ entry\.minutes_delta/);
});
