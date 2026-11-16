import assert from "node:assert/strict";
import test from "node:test";

import {
  clearMaterialOrderRecovery,
  getMaterialOrderRecoveryKey,
  materialOrderRectStyle,
  materialOrderValuesEqual,
  normalizeMaterialOrderValues,
  readMaterialOrderRecovery,
  writeMaterialOrderRecovery,
} from "../src/lib/materialOrders.ts";

const form = {
  width: 600,
  height: 800,
  fields: [
    { name: "customer", label: "Kunde", type: "text", rect: [60, 80, 240, 20], max_length: 120 },
    { name: "packed_1", label: "Gepackt", type: "checkbox", rect: [540, 400, 12, 12], max_length: null },
  ],
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("descriptor coordinates are converted from top-left PDF points into overlay percentages", () => {
  assert.deepEqual(materialOrderRectStyle([60, 80, 240, 20], form), {
    left: "10%",
    top: "10%",
    width: "40%",
    height: "2.5%",
  });
});

test("descriptor types normalize draft values without leaking unknown fields", () => {
  assert.deepEqual(normalizeMaterialOrderValues(form, {
    customer: "Muster GmbH",
    packed_1: true,
    legacy_field: "ignored",
  }), {
    customer: "Muster GmbH",
    packed_1: true,
  });
  assert.deepEqual(normalizeMaterialOrderValues(form, { customer: false, packed_1: "yes" }), {
    customer: "",
    packed_1: false,
  });
  assert.equal(materialOrderValuesEqual({ customer: "A" }, { customer: "A" }), true);
  assert.equal(materialOrderValuesEqual({ customer: "A" }, { customer: "B" }), false);
});

test("local recovery is scoped per site and user and rejects malformed content", () => {
  const storage = memoryStorage();
  const key = getMaterialOrderRecoveryKey(101, 7);
  assert.equal(writeMaterialOrderRecovery(storage, key, {
    draftId: "draft-1",
    revision: 3,
    values: { customer: "Lokal", packed_1: false },
    savedAt: "2026-11-16T09:00:00.000Z",
  }), true);
  assert.deepEqual(readMaterialOrderRecovery(storage, key), {
    draftId: "draft-1",
    revision: 3,
    values: { customer: "Lokal", packed_1: false },
    savedAt: "2026-11-16T09:00:00.000Z",
  });
  storage.setItem(key, "not-json");
  assert.equal(readMaterialOrderRecovery(storage, key), null);
  assert.notEqual(getMaterialOrderRecoveryKey(101, 7), getMaterialOrderRecoveryKey(101, 8));
});

test("recovery storage failures never block editing or cleanup", () => {
  const unavailableStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("full"); },
    removeItem() { throw new Error("blocked"); },
  };
  const recovery = {
    draftId: "draft-2",
    revision: 1,
    values: { customer: "Bleibt im React-State" },
    savedAt: "2026-11-16T10:00:00.000Z",
  };
  assert.equal(readMaterialOrderRecovery(unavailableStorage, "key"), null);
  assert.equal(writeMaterialOrderRecovery(unavailableStorage, "key", recovery), false);
  assert.doesNotThrow(() => clearMaterialOrderRecovery(unavailableStorage, "key"));
});

test("recovery parsing retains only supported scalar field values", () => {
  const storage = memoryStorage();
  storage.setItem("key", JSON.stringify({
    draftId: "draft-3",
    revision: 2,
    values: { customer: "Kunde", packed_1: true, ignored: { nested: true }, alsoIgnored: 12 },
    savedAt: "2026-11-16T11:00:00.000Z",
  }));
  assert.deepEqual(readMaterialOrderRecovery(storage, "key")?.values, {
    customer: "Kunde",
    packed_1: true,
  });
});
