import assert from "node:assert/strict";
import test from "node:test";

import { resolveViewportPopoverPosition } from "../src/lib/viewportPopover.ts";

const baseInput = {
  triggerTop: 100,
  triggerBottom: 124,
  triggerLeft: 100,
  menuWidth: 150,
  menuHeight: 220,
  viewportWidth: 1200,
  viewportHeight: 800,
};

test("payroll entry menu opens below when the viewport has enough room", () => {
  const position = resolveViewportPopoverPosition(baseInput);

  assert.equal(position.placement, "below");
  assert.equal(position.top, 128);
  assert.equal(position.left, 100);
});

test("payroll entry menu flips above a trigger near the viewport bottom", () => {
  const position = resolveViewportPopoverPosition({
    ...baseInput,
    triggerTop: 650,
    triggerBottom: 674,
    viewportHeight: 700,
  });

  assert.equal(position.placement, "above");
  assert.equal(position.top, 426);
  assert.ok(position.top >= 8);
});

test("payroll entry menu limits its height when neither side fits", () => {
  const position = resolveViewportPopoverPosition({
    ...baseInput,
    triggerTop: 100,
    triggerBottom: 124,
    menuHeight: 400,
    viewportHeight: 240,
  });

  assert.equal(position.placement, "below");
  assert.equal(position.maxHeight, 104);
  assert.equal(position.top + position.maxHeight, 232);
});

test("payroll entry menu shifts away from both horizontal viewport edges", () => {
  assert.equal(resolveViewportPopoverPosition({
    ...baseInput,
    triggerLeft: 780,
    menuWidth: 160,
    viewportWidth: 800,
  }).left, 632);

  assert.equal(resolveViewportPopoverPosition({
    ...baseInput,
    triggerLeft: -20,
  }).left, 8);
});
