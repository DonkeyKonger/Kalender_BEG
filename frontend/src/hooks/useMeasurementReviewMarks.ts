import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent, RefObject } from "react";
import { getMeasurementReviewCell, paintMeasurementReviewMarks, readMeasurementReviewMarks, toggleMeasurementReviewMark, writeMeasurementReviewMarks } from "../lib/measurementReviewMarks";

export function useMeasurementReviewMarks(tableRef: RefObject<HTMLTableElement | null>, cacheKey: string | null) {
  const state = useRef<{ key: string | null; marks: Set<string> } | null>(null);
  const load = useCallback(() => {
    try { return cacheKey ? readMeasurementReviewMarks(window.localStorage, cacheKey) : new Set<string>(); }
    catch { return new Set<string>(); }
  }, [cacheKey]);
  // Reapply after React replaces cells, without rerendering uncontrolled editors
  // or triggering any of the measurement's save/blur handlers.
  useLayoutEffect(() => {
    if (!state.current || state.current.key !== cacheKey) state.current = { key: cacheKey, marks: load() };
    if (tableRef.current) paintMeasurementReviewMarks(tableRef.current, state.current.marks);
  });
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== null && event.key !== cacheKey) return;
      state.current = { key: cacheKey, marks: load() };
      if (tableRef.current) paintMeasurementReviewMarks(tableRef.current, state.current.marks);
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [cacheKey, load, tableRef]);
  return {
    onMouseDownCapture(event: MouseEvent<HTMLTableElement>) {
      // Right-clicking must not blur another draft and accidentally save it.
      if (event.button === 2 && getMeasurementReviewCell(event.target, event.currentTarget)) event.preventDefault();
    },
    onContextMenuCapture(event: MouseEvent<HTMLTableElement>) {
      const cell = getMeasurementReviewCell(event.target, event.currentTarget);
      if (!cell || !state.current) return;
      event.preventDefault();
      event.stopPropagation();
      toggleMeasurementReviewMark(state.current.marks, cell.dataset.reviewMarkKey!);
      paintMeasurementReviewMarks(event.currentTarget, state.current.marks);
      try {
        if (cacheKey) writeMeasurementReviewMarks(window.localStorage, cacheKey, state.current.marks);
      } catch { /* Private browsing can deny access to localStorage itself. */ }
    },
  };
}
