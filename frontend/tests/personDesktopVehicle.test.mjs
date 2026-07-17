import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [personsPageSource, personTypesSource] = await Promise.all([
  readFile(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/types/person.ts", import.meta.url), "utf8"),
]);

test("desktop employee details show the assigned vehicle in the master data grid", () => {
  assert.match(personsPageSource, /<PersonDetailField label="Fahrzeug">/);
  assert.match(personsPageSource, /person\.assigned_vehicle\?\.license_plate/);
  assert.match(personsPageSource, /Kein Fahrzeug zugewiesen/);
  assert.match(personTypesSource, /assigned_vehicle\?: \{/);
});

test("desktop employee navigation no longer contains a vehicle subpage", () => {
  assert.doesNotMatch(personsPageSource, /Fahrzeugzuordnung wird vorbereitet/);
  assert.doesNotMatch(personsPageSource, /key: "vehicle"/);
});
