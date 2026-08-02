import type { TimeEntryPayrollWeekPerson } from "../types/timeEntry";

export function payrollWeekPersonsById(
  persons: TimeEntryPayrollWeekPerson[],
): Map<number, TimeEntryPayrollWeekPerson> {
  return new Map(persons.map((person) => [person.person_id, person]));
}

export function payrollWeekTotalMinutes(
  person: TimeEntryPayrollWeekPerson | undefined,
  fallbackMinutes: number,
): number {
  return person?.total_minutes ?? fallbackMinutes;
}

export function vacationCreditMinutesForDate(
  person: TimeEntryPayrollWeekPerson | null | undefined,
  workDate: string,
): number {
  return person?.vacation_days.find((day) => day.work_date === workDate)?.vacation_credit_minutes ?? 0;
}
