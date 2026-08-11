import assert from "node:assert/strict";
import test from "node:test";

import {
  planningAbsenceTypePriority,
  sortPlanningAbsenceEntries,
} from "../src/lib/planningAbsenceSort.ts";

function classic(id, absenceType, personName) {
  return {
    kind: "classic",
    absence: { id, absence_type: absenceType },
    personName,
  };
}

function operational(id, personName) {
  return {
    kind: "operational",
    operationalAbsence: { id },
    personName,
  };
}

test("mixed planning absences are grouped by the fixed type priority and then German name order", () => {
  const sorted = sortPlanningAbsenceEntries([
    classic(1, "vacation", "S. Just"),
    classic(2, "sick", "Z. Beispiel"),
    classic(3, "school", "B. Beispiel"),
    operational(4, "C. Erichsen"),
    classic(5, "vacation", "D. Kwiatkowski"),
    classic(6, "free", "M. Beispiel"),
    classic(7, "other", "F. Beispiel"),
    classic(8, "sick", "a. Beispiel"),
    classic(9, "vacation", "H. Wartmann"),
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.personName),
    [
      "C. Erichsen",
      "a. Beispiel",
      "Z. Beispiel",
      "D. Kwiatkowski",
      "H. Wartmann",
      "S. Just",
      "M. Beispiel",
      "B. Beispiel",
      "F. Beispiel",
    ],
  );
});

test("multiple operational absences are ordered by name rather than start or insertion order", () => {
  const sorted = sortPlanningAbsenceEntries([
    operational(3, "K. Beispiel"),
    operational(1, "C. Erichsen"),
    operational(2, "A. Beispiel"),
  ]);

  assert.deepEqual(sorted.map((entry) => entry.personName), ["A. Beispiel", "C. Erichsen", "K. Beispiel"]);
});

test("the sorted full list is split only after priority ordering and keeps the same overflow order", () => {
  const sorted = sortPlanningAbsenceEntries([
    classic(7, "vacation", "V. Vier"),
    classic(6, "vacation", "V. Drei"),
    classic(5, "vacation", "V. Zwei"),
    classic(4, "vacation", "V. Eins"),
    classic(3, "sick", "K. Zwei"),
    classic(2, "sick", "K. Eins"),
    operational(1, "P. Leitung"),
  ]);
  const visible = sorted.slice(0, 4);
  const overflow = sorted.slice(4);

  assert.deepEqual(visible.map((entry) => entry.personName), ["P. Leitung", "K. Eins", "K. Zwei", "V. Drei"]);
  assert.deepEqual(overflow.map((entry) => entry.personName), ["V. Eins", "V. Vier", "V. Zwei"]);
});

test("unknown classic absence types use the other fallback priority", () => {
  assert.equal(planningAbsenceTypePriority("unexpected"), planningAbsenceTypePriority("other"));

  const sorted = sortPlanningAbsenceEntries([
    classic(2, "unexpected", "A. Unbekannt"),
    classic(1, "school", "Z. Schule"),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.personName), ["Z. Schule", "A. Unbekannt"]);
});
