import type { AbsenceType } from "../types/matrix";

type SortableClassicAbsenceItem = {
  kind: "classic";
  absence: {
    absence_type: AbsenceType;
    id: number;
  };
  personName: string;
};

type SortableOperationalAbsenceItem = {
  kind: "operational";
  operationalAbsence: {
    id: number;
  };
  personName: string;
};

type SortablePlanningAbsenceItem = SortableClassicAbsenceItem | SortableOperationalAbsenceItem;

const OTHER_ABSENCE_PRIORITY = 5;

const classicAbsenceTypePriority: Readonly<Record<AbsenceType, number>> = {
  sick: 1,
  vacation: 2,
  free: 3,
  school: 4,
  other: OTHER_ABSENCE_PRIORITY,
};

const germanNameCollator = new Intl.Collator("de-DE", {
  sensitivity: "base",
  usage: "sort",
});

export function planningAbsenceTypePriority(absenceType: AbsenceType | string): number {
  return classicAbsenceTypePriority[absenceType as AbsenceType] ?? OTHER_ABSENCE_PRIORITY;
}

export function sortPlanningAbsenceEntries<T extends SortablePlanningAbsenceItem>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => (
    planningAbsenceEntryPriority(left) - planningAbsenceEntryPriority(right)
    || germanNameCollator.compare(left.personName, right.personName)
    || planningAbsenceStableId(left) - planningAbsenceStableId(right)
  ));
}

function planningAbsenceEntryPriority(entry: SortablePlanningAbsenceItem): number {
  return entry.kind === "operational"
    ? 0
    : planningAbsenceTypePriority(entry.absence.absence_type);
}

function planningAbsenceStableId(entry: SortablePlanningAbsenceItem): number {
  return entry.kind === "operational" ? entry.operationalAbsence.id : entry.absence.id;
}
