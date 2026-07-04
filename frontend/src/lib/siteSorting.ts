export function compareSiteNumbers(left: string | null | undefined, right: string | null | undefined): number {
  const leftNumber = parseSiteNumber(left);
  const rightNumber = parseSiteNumber(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== null) {
    return -1;
  }
  if (rightNumber !== null) {
    return 1;
  }
  return (left ?? "").localeCompare(right ?? "", "de");
}

function parseSiteNumber(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const matches = value.match(/\d+/g);
  return matches?.length ? Number(matches[matches.length - 1]) : null;
}
