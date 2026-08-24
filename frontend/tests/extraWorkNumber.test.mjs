import assert from "node:assert/strict";
import test from "node:test";

import { formatExtraWorkSequenceLabel } from "../src/lib/extraWorkNumber.ts";


test("extra-work labels retain legacy SZ numbers and accept new Z numbers", () => {
  assert.equal(formatExtraWorkSequenceLabel("9999.SZ15", 15), "SZ15");
  assert.equal(formatExtraWorkSequenceLabel("9999.Z16", 16), "Z16");
  assert.equal(formatExtraWorkSequenceLabel(" 9999.z017 ", 17), "Z017");
});


test("extra-work label parser rejects lookalike document numbers", () => {
  assert.equal(formatExtraWorkSequenceLabel("9999.AZ88", 18), "Z18");
  assert.equal(formatExtraWorkSequenceLabel("9999.Z18.pdf", 18), "Z18");
  assert.equal(formatExtraWorkSequenceLabel(null, 3), "Z03");
});
