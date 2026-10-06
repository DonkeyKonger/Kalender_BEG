import type { WarehouseToolPage } from "../types/warehouse";

type FetchPage = (search: string, offset: number, signal: AbortSignal) => Promise<WarehouseToolPage>;
type ListState = {
  search: string;
  offset: number;
  page: WarehouseToolPage | null;
  pageOffset: number;
  pageSearch: string;
  loading: boolean;
  error: unknown;
};

/** In-memory state for one person/direction, retained across the signature step. */
export function createWarehouseToolList(fetchPage: FetchPage) {
  let state: ListState = { search: "", offset: 0, page: null, pageOffset: 0, pageSearch: "", loading: true, error: null };
  const listeners = new Set<() => void>();
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  function update(patch: Partial<ListState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    request?.abort();
    request = undefined;
  }
  async function load() {
    if (!active) return;
    const controller = new AbortController();
    request = controller;
    const { offset } = state;
    const search = state.search.trim();
    try {
      const page = await fetchPage(search, offset, controller.signal);
      if (request !== controller || controller.signal.aborted) return;
      // Stock can shrink while signing; never return to an out-of-range page.
      if (offset > 0 && offset >= page.total) {
        update({ offset: page.total ? Math.floor((page.total - 1) / 40) * 40 : 0 });
        if (page.total) { refresh(); return; }
      }
      update({ page, pageOffset: page.total ? offset : 0, pageSearch: search, loading: false, error: null });
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return;
      update({ loading: false, error });
    }
  }
  function refresh(delay = 0) {
    cancel();
    update({ loading: true, error: null });
    if (!active) return;
    if (delay) timer = setTimeout(() => { timer = undefined; void load(); }, delay);
    else void load();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    resume() {
      active = true;
      // Revalidate immediately without discarding the last visible page.
      refresh();
    },
    pause() {
      active = false;
      cancel();
    },
    search(value: string) {
      const changed = value.trim() !== state.search.trim();
      update({ search: value, ...(changed ? { offset: 0 } : {}) });
      if (changed) refresh(value.trim() ? 180 : 0);
    },
    goTo(offset: number) {
      if (state.loading || state.error || offset < 0 || offset === state.offset) return;
      update({ offset });
      refresh();
    },
    retry: () => refresh(),
  };
}
