import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent, RefObject } from "react";
import { clearMeasurementReviewSelection, getMeasurementReviewCell, paintMeasurementReviewMarks, readMeasurementReviewMarks, toggleMeasurementReviewMark, writeMeasurementReviewMarks } from "../lib/measurementReviewMarks";

export function useMeasurementReviewMarks(tableRef: RefObject<HTMLTableElement | null>, cacheKey: string | null) {
  const state = useRef<{ key: string | null; marks: Set<string> } | null>(null);
  const selectionFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
  }, []);
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
  function preventRightClickSelection(event: MouseEvent<HTMLTableElement>) {
    if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) {
      // A subsequent normal click owns its selection again.
      if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = null;
      return;
    }
    const cell = getMeasurementReviewCell(event.target, event.currentTarget);
    if (!cell) return;
    // Intercept before native word selection/focus, without saving another draft.
    event.preventDefault();
    clearMeasurementReviewSelection(cell);
  }
  return {
    onPointerDownCapture: preventRightClickSelection,
    onMouseDownCapture: preventRightClickSelection,
    onContextMenuCapture(event: MouseEvent<HTMLTableElement>) {
      const cell = getMeasurementReviewCell(event.target, event.currentTarget);
      if (!cell || !state.current) return;
      event.preventDefault();
      event.stopPropagation();
      clearMeasurementReviewSelection(cell);
      if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = window.requestAnimationFrame(() => {
        // Safari may perform native context-menu selection after the event handler.
        if (cell.isConnected) clearMeasurementReviewSelection(cell);
        selectionFrame.current = null;
      });
      toggleMeasurementReviewMark(state.current.marks, cell.dataset.reviewMarkKey!);
      paintMeasurementReviewMarks(event.currentTarget, state.current.marks);
      try {
        if (cacheKey) writeMeasurementReviewMarks(window.localStorage, cacheKey, state.current.marks);
      } catch { /* Private browsing can deny access to localStorage itself. */ }
    },
  };
}
