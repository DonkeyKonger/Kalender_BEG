import type { MobileAssignmentColleague } from "../types/mobile";

const dayMs = 86_400_000;
const weekday = new Intl.DateTimeFormat("de-DE", { weekday: "short", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

/** Clip to this card, deduplicate by person/date and never bridge an unplanned day. */
export function formatAssignmentColleagues(
  colleagues: MobileAssignmentColleague[], start: string, end: string, ownPersonId: number,
) {
  const first = Date.parse(start);
  const last = Date.parse(end);
  const showDate = last - first >= 7 * dayMs;
  const people = new Map<number, { name: string; days: Set<number> }>();
  for (const colleague of colleagues) {
    if (colleague.person_id === ownPersonId) continue;
    const from = Math.max(first, Date.parse(colleague.start_date));
    const through = Math.min(last, Date.parse(colleague.end_date));
    if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) continue;
    const person = people.get(colleague.person_id) ?? { name: colleague.last_name, days: new Set<number>() };
    for (let day = from; day <= through; day += dayMs) person.days.add(day);
    people.set(colleague.person_id, person);
  }
  const label = (day: number) => `${weekday.format(day).replace(/\.$/, "")}${showDate ? ` ${shortDate.format(day)}` : ""}`;
  return [...people.entries()].map(([personId, person]) => {
    const days = [...person.days].sort((a, b) => a - b);
    const periods: { start: number; end: number }[] = [];
    for (const day of days) {
      const previous = periods.at(-1);
      if (previous && previous.end + dayMs === day) previous.end = day;
      else periods.push({ start: day, end: day });
    }
    return {
      personId,
      name: person.name,
      period: periods.map(range => range.start === range.end ? label(range.start) : `${label(range.start)}–${label(range.end)}`).join(", "),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "de") || a.personId - b.personId);
}
