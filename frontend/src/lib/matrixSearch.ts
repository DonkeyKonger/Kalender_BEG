import type { MatrixRow } from "../types/matrix";
import type { Person } from "../types/person";

export type MatrixSearchRange = { start: string; end: string };

function normalized(value: string): string {
  return value.toLocaleLowerCase("de").normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
}

/** Search only filters rows; assignments and their dates are never changed. */
export function searchMatrixRows(
  rows: MatrixRow[], query: string, people: Person[], range: MatrixSearchRange | null,
): MatrixRow[] {
  const tokens = normalized(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return rows;
  const matches = (values: (string | null | undefined)[]) => {
    const text = normalized(values.filter(Boolean).join(" "));
    return tokens.every((token) => text.includes(token));
  };
  const peopleById = new Map(people.map((person) => [person.id, person]));
  return rows.filter((row) => {
    if (matches([row.site.site_number, row.site.name, row.site.location])) return true;
    return range !== null && row.cells.some((cell) => (
      cell.date >= range.start && cell.date <= range.end && cell.assignments.some(({ person }) => {
        const details = peopleById.get(person.id);
        if (person.person_type === "internal" && details?.user_roles?.some(
          (role) => role === "office" || role === "admin" || role === "project_manager",
        )) return false;
        // Keep historical assignments searchable, including inactive and temporary staff.
        return matches([person.display_name, person.short_code, details?.first_name, details?.last_name]);
      })
    ));
  });
}

/** Partially visible day columns count; columns hidden behind the fixed site fields do not. */
export function matrixSearchRangeAtViewport(
  columns: { date: string; width: number }[], scrollLeft: number, viewportWidth: number,
): MatrixSearchRange | null {
  if (viewportWidth <= 0) return null;
  let offset = 0;
  let start: string | undefined;
  let end: string | undefined;
  for (const column of columns) {
    if (offset + column.width > scrollLeft + 1 && offset < scrollLeft + viewportWidth - 1) {
      start ??= column.date;
      end = column.date;
    }
    offset += column.width;
  }
  return start && end ? { start, end } : null;
}
