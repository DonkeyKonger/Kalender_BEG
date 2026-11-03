import assert from "node:assert/strict";
import test from "node:test";
import { absenceCreator } from "../src/lib/absenceCreator.ts";

test("absence attribution uses the employee name instead of the generated short code", () => {
  assert.deepEqual(absenceCreator({
    created_by_short_code: "C.CE", created_by_name: " CE ",
    updated_by_user_id: 99, person_id: 123,
  }), { label: "CE", description: "Eingetragen von CE" });
  assert.deepEqual(absenceCreator({
    created_by_short_code: "K.Erichsen", created_by_name: "KE",
  }), { label: "KE", description: "Eingetragen von KE" });
});

test("missing legacy attribution is not replaced by the absent person or editor", () => {
  assert.deepEqual(absenceCreator({ person_id: 123, updated_by_user_id: 99 }), {
    label: "–", description: "Ersteller nicht hinterlegt",
  });
  assert.deepEqual(absenceCreator({ created_by_short_code: null, created_by_name: " " }), {
    label: "–", description: "Ersteller nicht hinterlegt",
  });
});

test("initials are derived from the employee name while full names remain accessible", () => {
  assert.deepEqual(absenceCreator({ created_by_short_code: "C.Hinz", created_by_name: "Carsten Hinz" }), {
    label: "CH", description: "Eingetragen von Carsten Hinz",
  });
  assert.deepEqual(absenceCreator({ created_by_short_code: "C.CE" }), {
    label: "–", description: "Ersteller nicht hinterlegt",
  });
  assert.deepEqual(absenceCreator({ created_by_name: "Christopher Beispiel" }), {
    label: "CB", description: "Eingetragen von Christopher Beispiel",
  });
});

test("one-word names longer than two letters use only their first initial", () => {
  for (const [name, label] of [["Administrator", "A"], ["max", "M"], ["Özlem", "Ö"], ["CE", "CE"], ["KE", "KE"], ["A", "A"]]) {
    assert.deepEqual(absenceCreator({ created_by_name: name }), {
      label, description: `Eingetragen von ${name}`,
    });
  }
});

test("all name parts contribute an uppercase initial", () => {
  for (const [name, label] of [["max Mustermann", "MM"], ["Max   Mustermann", "MM"], ["Anna Maria Muster", "AMM"], ["Karl-Heinz Müller", "KHM"]]) {
    assert.deepEqual(absenceCreator({ created_by_name: name }), {
      label, description: `Eingetragen von ${name}`,
    });
  }
});
