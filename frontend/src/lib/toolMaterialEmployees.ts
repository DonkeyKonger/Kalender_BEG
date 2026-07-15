export type ToolMaterialEmployeeSource = {
  id: number;
  display_name: string;
  short_code: string;
  person_type: "internal" | "external" | "external_temp";
  is_active: boolean;
  first_name?: string | null;
  last_name?: string | null;
  deleted_at?: string | null;
};

export type ToolMaterialEmployeePickerOption = {
  value: string;
  label: string;
  searchText: string;
  groupLabel: "Interne Mitarbeiter" | "Externe Mitarbeiter";
};

export function buildToolMaterialEmployeeOptions(
  people: ToolMaterialEmployeeSource[],
  historicalEmployee: ToolMaterialEmployeeSource | null,
): ToolMaterialEmployeePickerOption[] {
  const activePeople = people.filter((person) => person.is_active && !person.deleted_at);
  const selectedId = historicalEmployee?.id ?? null;
  if (
    historicalEmployee
    && !activePeople.some((person) => person.id === selectedId)
  ) {
    activePeople.push(historicalEmployee);
  }

  const uniquePeople = [...new Map(activePeople.map((person) => [person.id, person])).values()];
  return uniquePeople
    .map((person) => ({
      value: String(person.id),
      label: `${person.display_name}${person.is_active ? "" : " (inaktiv)"}`,
      searchText: [
        person.first_name,
        person.last_name,
        person.display_name,
        person.short_code,
      ].filter(Boolean).join(" "),
      groupLabel: person.person_type === "internal" ? "Interne Mitarbeiter" as const : "Externe Mitarbeiter" as const,
    }))
    .sort((left, right) => (
      groupOrder(left.groupLabel) - groupOrder(right.groupLabel)
      || left.label.localeCompare(right.label, "de", { sensitivity: "base" })
      || Number(left.value) - Number(right.value)
    ));
}

function groupOrder(group: ToolMaterialEmployeePickerOption["groupLabel"]): number {
  return group === "Interne Mitarbeiter" ? 0 : 1;
}
