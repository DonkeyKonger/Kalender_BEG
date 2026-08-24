export function formatExtraWorkSequenceLabel(
  displayNumber: string | null | undefined,
  sequenceNumber: number,
): string {
  const normalizedDisplayNumber = displayNumber?.trim() ?? "";
  const match = normalizedDisplayNumber.match(
    /(?:^|[.\s_-])((?:SZ|Z)0*[1-9]\d*)$/i,
  );
  return match?.[1].toUpperCase()
    ?? `Z${String(sequenceNumber).padStart(2, "0")}`;
}
