import assert from "node:assert/strict";
import test from "node:test";
import { absenceCreator } from "../src/lib/absenceCreator.ts";

test("absence attribution uses the supplied creator's configured code and full name", () => {
  assert.deepEqual(absenceCreator({
    created_by_short_code: " CE ", created_by_name: " Christopher Beispiel ",
    updated_by_user_id: 99, person_id: 123,
  }), { code: "CE", description: "Eingetragen von Christopher Beispiel (CE)" });
});

test("missing legacy attribution is not replaced by the absent person or editor", () => {
  assert.deepEqual(absenceCreator({ person_id: 123, updated_by_user_id: 99 }), {
    code: "–", description: "Ersteller nicht hinterlegt",
  });
  assert.deepEqual(absenceCreator({ created_by_short_code: null, created_by_name: " " }), {
    code: "–", description: "Ersteller nicht hinterlegt",
  });
});

test("available creator details remain accessible without duplicating a short name", () => {
  assert.deepEqual(absenceCreator({ created_by_short_code: "CE", created_by_name: "CE" }), {
    code: "CE", description: "Eingetragen von CE",
  });
  assert.deepEqual(absenceCreator({ created_by_short_code: "CE" }), {
    code: "CE", description: "Eingetragen von CE",
  });
  assert.deepEqual(absenceCreator({ created_by_name: "Christopher Beispiel" }), {
    code: "–", description: "Eingetragen von Christopher Beispiel",
  });
});
