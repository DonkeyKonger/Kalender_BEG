export function containsDraggedFiles(types: ArrayLike<string>): boolean {
  return Array.from(types).some((type) => type === "Files" || type === "application/x-moz-file");
}
