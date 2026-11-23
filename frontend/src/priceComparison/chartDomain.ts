export type PriceChartDomain = {
  floor: number;
  ceiling: number;
};

const MINIMUM_BAR_SHARE = 1 / 3;
const RANGE_PADDING_SHARE = 0.16;
const RELATIVE_RANGE_FLOOR = 0.12;
const ABSOLUTE_RANGE_FLOOR = 0.01;

/**
 * Build the cropped linear domain for the article price chart.
 *
 * For non-negative price data the scale never invents a negative axis. The
 * smallest offer therefore occupies at least one third of the plot only when
 * that is possible without crossing zero. Zero and very wide ranges stop at
 * zero, as requested. Reference values (Datanorm and median) always remain in
 * range.
 *
 * Negative inputs are not present in the migrated dataset. If they appear in
 * future, they are retained on a naturally padded negative domain instead of
 * being clipped at zero; the same one-third target is applied when finite
 * arithmetic permits it.
 */
export function getPriceChartDomain(
  offerPrices: readonly number[],
  referencePrices: readonly number[] = [],
): PriceChartDomain {
  const offers = offerPrices.filter(Number.isFinite);
  const references = referencePrices.filter(Number.isFinite);
  const values = offers.length ? [...offers, ...references] : references;

  if (!values.length) return { floor: 0, ceiling: 1 };

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum));
  const difference = maximum - minimum;
  const stableDifference = Number.isFinite(difference) ? difference : magnitude;
  const range = Math.max(
    stableDifference,
    magnitude * RELATIVE_RANGE_FLOOR,
    ABSOLUTE_RANGE_FLOOR,
  );
  const padding = range * RANGE_PADDING_SHARE;

  const paddedCeiling = maximum + padding;
  const ceiling = Number.isFinite(paddedCeiling) ? paddedCeiling : maximum;
  const paddedMinimum = minimum - padding;
  let floor = Number.isFinite(paddedMinimum) ? paddedMinimum : minimum;

  if (minimum >= 0) floor = Math.max(0, floor);

  if (offers.length) {
    const smallestOffer = Math.min(...offers);
    const targetFloor = (
      smallestOffer - MINIMUM_BAR_SHARE * ceiling
    ) / (1 - MINIMUM_BAR_SHARE);
    if (Number.isFinite(targetFloor)) floor = Math.min(floor, targetFloor);
    if (minimum >= 0) floor = Math.max(0, floor);
  }

  return { floor, ceiling };
}
