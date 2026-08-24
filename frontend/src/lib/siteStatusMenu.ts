export function getSiteStatusMenuNavigationIndex(
  currentIndex: number,
  optionCount: number,
  key: string,
): number | null {
  if (optionCount < 1) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return optionCount - 1;
  }
  if (key === "ArrowDown") {
    return currentIndex < 0 ? 0 : (currentIndex + 1) % optionCount;
  }
  if (key === "ArrowUp") {
    return currentIndex < 0 ? optionCount - 1 : (currentIndex - 1 + optionCount) % optionCount;
  }
  return null;
}
