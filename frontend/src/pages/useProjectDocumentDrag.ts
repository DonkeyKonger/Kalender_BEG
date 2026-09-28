import { useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { api, ApiError } from "../lib/api";
import { PROJECT_DOCUMENT_DRAG_TYPE, sameDocumentLocation, type DocumentLocation, type DocumentMove } from "../lib/projectDocumentMove";
import type { ProjectFolderDocumentItem } from "../types/site";

export function useProjectDocumentDrag(siteId: number, canEdit: boolean, onMoved: () => void) {
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const drag = useRef<{ item: ProjectFolderDocumentItem; source: DocumentLocation } | null>(null);
  const pending = useRef(false);
  const [isDragging, setDragging] = useState(false);
  const [isMoving, setMoving] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<DocumentMove | null>(null);
  const key = (location: DocumentLocation) => JSON.stringify([location.folderKey, location.parentId]);
  function endDrag() { drag.current = null; setDragging(false); setHighlight(null); }
  function isInternal(event: DragEvent<HTMLElement>) {
    return canEdit && !pending.current && drag.current !== null && Array.from(event.dataTransfer.types).includes(PROJECT_DOCUMENT_DRAG_TYPE);
  }
  function sourceProps(item: ProjectFolderDocumentItem, source: DocumentLocation): HTMLAttributes<HTMLElement> {
    return {
      draggable: canEdit && !isMoving && !item.is_folder && Boolean(item.id),
      onDragStart(event) {
        if (!canEdit || pending.current || item.is_folder || (event.target instanceof Element && event.target.closest("input, textarea"))) {
          event.preventDefault(); return;
        }
        drag.current = { item, source };
        event.dataTransfer.setData(PROJECT_DOCUMENT_DRAG_TYPE, item.id);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      },
      onDragEnd: endDrag,
    };
  }
  function targetProps(target: DocumentLocation): HTMLAttributes<HTMLElement> {
    return {
      onDragOver(event) {
        if (!isInternal(event)) return;
        event.preventDefault(); event.stopPropagation();
        const valid = !sameDocumentLocation(drag.current!.source, target);
        event.dataTransfer.dropEffect = valid ? "move" : "none";
        setHighlight(valid ? key(target) : null);
      },
      onDragLeave(event) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setHighlight(current => current === key(target) ? null : current);
      },
      onDrop(event) {
        if (!isInternal(event)) return;
        event.preventDefault(); event.stopPropagation();
        const current = drag.current!;
        const matches = event.dataTransfer.getData(PROJECT_DOCUMENT_DRAG_TYPE) === current.item.id;
        endDrag();
        if (!matches || sameDocumentLocation(current.source, target)) return;
        pending.current = true; setMoving(true); setMessage(null); setError(null);
        void api.moveProjectFolderDocument(siteId, current.source.folderKey, current.item.id, target.folderKey, target.parentId)
          .then(item => {
            setLastMove({ source: current.source, target, item });
            setMessage(`„${item.name}“ wurde verschoben.`);
            onMovedRef.current();
          })
          .catch(cause => setError(cause instanceof ApiError ? cause.message : "Datei konnte nicht verschoben werden."))
          .finally(() => { pending.current = false; setMoving(false); });
      },
    };
  }
  return { sourceProps, targetProps, isInternal, isDragging, isMoving, lastMove, message, error,
    isHighlighted: (target: DocumentLocation) => highlight === key(target) };
}
export type ProjectDocumentDrag = ReturnType<typeof useProjectDocumentDrag>;
