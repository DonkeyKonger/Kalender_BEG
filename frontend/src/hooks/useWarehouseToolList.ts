import { useEffect, useMemo, useSyncExternalStore } from "react";

import { api } from "../lib/api";
import { createWarehouseToolList } from "../lib/warehouseToolList";
import type { WarehouseDirection } from "../types/warehouse";

export function useWarehouseToolList(direction: WarehouseDirection | null, personId: number | null, active: boolean) {
  const list = useMemo(() => createWarehouseToolList((search, offset, signal) => {
    if (!direction || personId === null) throw new Error("Kein Lagervorgang ausgewählt.");
    return api.warehouseTools(direction, personId, search, offset, signal);
  }), [direction, personId]);
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot);
  useEffect(() => {
    if (!active || !direction || personId === null) return;
    list.resume();
    return () => list.pause();
  }, [active, direction, personId, list]);
  return { ...state, list };
}
