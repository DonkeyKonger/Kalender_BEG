export type PickerSearchOption = {
  searchText: string;
};

export function filterPickerOptions<Option extends PickerSearchOption>(
  options: Option[],
  query: string,
): Option[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
  if (!normalizedQuery) {
    return options;
  }
  return options.filter((option) => (
    option.searchText.toLocaleLowerCase("de-DE").includes(normalizedQuery)
  ));
}
