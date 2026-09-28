import type { ProjectFolderDocumentItem } from "../types/site";

export const PROJECT_DOCUMENT_DRAG_TYPE = "application/x-beg-project-document";
export type DocumentLocation = { folderKey: string; parentId: string | null };
export type DocumentMove = { source: DocumentLocation; target: DocumentLocation; item: ProjectFolderDocumentItem };
export function sameDocumentLocation(a: DocumentLocation, b: DocumentLocation): boolean {
  return a.folderKey === b.folderKey && a.parentId === b.parentId;
}

// Apply confirmed moves also to cached, previously visited folder levels.
export function applyDocumentMoves(items: ProjectFolderDocumentItem[], location: DocumentLocation, moves: DocumentMove[]) {
  let result = items;
  for (const move of moves) {
    if (sameDocumentLocation(move.source, location) || sameDocumentLocation(move.target, location)) {
      result = result.filter(item => item.id !== move.item.id);
      if (sameDocumentLocation(move.target, location)) result = [...result, move.item];
    }
  }
  return result;
}
