export type PayrollEvaluationEntry = {
  personName: string;
  siteKey: string;
  finalMinutes: number | null;
};

export type PayrollEvaluationTotals = {
  totalMinutes: number;
  byPerson: { label: string; minutes: number }[];
  bySite: { label: string; minutes: number }[];
};

export function calculatePayrollEvaluationTotals(entries: PayrollEvaluationEntry[]): PayrollEvaluationTotals {
  const byPerson = new Map<string, number>();
  const bySite = new Map<string, number>();
  let totalMinutes = 0;
  for (const entry of entries) {
    const minutes = entry.finalMinutes ?? 0;
    totalMinutes += minutes;
    byPerson.set(entry.personName, (byPerson.get(entry.personName) ?? 0) + minutes);
    bySite.set(entry.siteKey, (bySite.get(entry.siteKey) ?? 0) + minutes);
  }
  return {
    totalMinutes,
    byPerson: mapTotalsToRows(byPerson),
    bySite: mapTotalsToRows(bySite),
  };
}

function mapTotalsToRows(totals: Map<string, number>): { label: string; minutes: number }[] {
  return [...totals.entries()]
    .map(([label, minutes]) => ({ label, minutes }))
    .sort((left, right) => left.label.localeCompare(right.label, "de", { sensitivity: "base" }));
}
