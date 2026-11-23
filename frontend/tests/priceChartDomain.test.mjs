import assert from "node:assert/strict";
import test from "node:test";

import { getPriceChartDomain } from "../src/priceComparison/chartDomain.ts";

const ONE_THIRD = 1 / 3;
const EPSILON = 1e-12;

function barShare(value, domain) {
  return (value - domain.floor) / (domain.ceiling - domain.floor);
}

function assertFiniteDomain(domain) {
  assert.equal(Number.isFinite(domain.floor), true);
  assert.equal(Number.isFinite(domain.ceiling), true);
  assert.ok(domain.ceiling > domain.floor, `${domain.ceiling} must be above ${domain.floor}`);
}

function assertContains(domain, values) {
  for (const value of values.filter(Number.isFinite)) {
    assert.ok(domain.floor <= value, `${domain.floor} must not clip ${value}`);
    assert.ok(domain.ceiling >= value, `${domain.ceiling} must not clip ${value}`);
  }
}

function assertClose(actual, expected, tolerance = EPSILON) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("the user price range gives the smallest bar exactly one third of the plot", () => {
  const offers = [14.81, 21.2];
  const references = [18.51];
  const domain = getPriceChartDomain(offers, references);

  assertFiniteDomain(domain);
  assertContains(domain, [...offers, ...references]);
  assertClose(domain.ceiling, 22.2224);
  assertClose(domain.floor, 11.1038);
  assertClose(barShare(Math.min(...offers), domain), ONE_THIRD);
});

test("a single or repeated price retains a useful cropped domain", () => {
  for (const offers of [[20], [20, 20, 20]]) {
    const domain = getPriceChartDomain(offers, [20]);
    assertFiniteDomain(domain);
    assertContains(domain, offers);
    assert.ok(domain.floor > 0);
    assertClose(barShare(20, domain), 0.5);
  }
});

test("zero prices stop at zero instead of creating a negative price axis", () => {
  const offers = [0, 800];
  const domain = getPriceChartDomain(offers);

  assertFiniteDomain(domain);
  assertContains(domain, offers);
  assert.equal(domain.floor, 0);
  assert.equal(barShare(0, domain), 0);
  assert.ok(barShare(0, domain) < ONE_THIRD);
});

test("a high Datanorm reference remains visible and the lower bound stops at zero", () => {
  const offers = [10, 12];
  const references = [100];
  const domain = getPriceChartDomain(offers, references);

  assertFiniteDomain(domain);
  assertContains(domain, [...offers, ...references]);
  assert.equal(domain.floor, 0);
  assert.ok(barShare(10, domain) < ONE_THIRD);
});

test("small cent values reach the one-third target without artificial euro padding", () => {
  const offers = [0.01, 0.02];
  const domain = getPriceChartDomain(offers);

  assertFiniteDomain(domain);
  assertContains(domain, offers);
  assert.ok(domain.floor > 0);
  assert.ok(domain.ceiling < 0.03);
  assertClose(barShare(Math.min(...offers), domain), ONE_THIRD);

  const singleCent = getPriceChartDomain([0.01]);
  assertFiniteDomain(singleCent);
  assertContains(singleCent, [0.01]);
  assert.ok(singleCent.ceiling < 0.02);
  assert.ok(barShare(0.01, singleCent) >= ONE_THIRD);
});

test("extreme finite spreads remain finite without inventing a negative axis", () => {
  const offers = [2.84, 600_002_315.791];
  const domain = getPriceChartDomain(offers);

  assertFiniteDomain(domain);
  assertContains(domain, offers);
  assert.equal(domain.floor, 0);
  assert.ok(domain.ceiling > Math.max(...offers));
});

test("non-negative datasets meet the one-third target whenever zero allows it", () => {
  const cases = [
    { offers: [14.81, 21.2], references: [18.51] },
    { offers: [80, 100], references: [] },
    { offers: [10, 12], references: [5] },
    { offers: [0.5, 0.6], references: [0.55] },
  ];

  for (const { offers, references } of cases) {
    const domain = getPriceChartDomain(offers, references);
    const share = barShare(Math.min(...offers), domain);
    assertContains(domain, [...offers, ...references]);
    assert.ok(domain.floor >= 0);
    assert.ok(share + EPSILON >= ONE_THIRD);
  }
});

test("negative inputs retain their natural range and are never clipped at zero", () => {
  const offers = [-10, -5];
  const references = [2];
  const domain = getPriceChartDomain(offers, references);

  assertFiniteDomain(domain);
  assertContains(domain, [...offers, ...references]);
  assert.ok(domain.floor < Math.min(...offers));
  assertClose(barShare(Math.min(...offers), domain), ONE_THIRD);
});

test("invalid numbers are ignored and empty input has a deterministic fallback", () => {
  const domain = getPriceChartDomain([Number.NaN, Number.POSITIVE_INFINITY, 10], [
    Number.NEGATIVE_INFINITY,
    12,
  ]);
  assertFiniteDomain(domain);
  assertContains(domain, [10, 12]);
  assert.ok(domain.floor >= 0);

  assert.deepEqual(getPriceChartDomain([Number.NaN], [Number.POSITIVE_INFINITY]), {
    floor: 0,
    ceiling: 1,
  });
});

test("reference-only and maximal finite inputs still produce containing domains", () => {
  const referenceOnly = getPriceChartDomain([], [10]);
  assertFiniteDomain(referenceOnly);
  assertContains(referenceOnly, [10]);

  const maximal = getPriceChartDomain([Number.MAX_VALUE], [-Number.MAX_VALUE]);
  assertFiniteDomain(maximal);
  assertContains(maximal, [-Number.MAX_VALUE, Number.MAX_VALUE]);
});
