import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PRICE_COMPARISON_DATA_CHANGED_EVENT,
  type ArticleSummary,
  priceRequest,
  queryPath,
} from "./client";

export type ArticleSearchIndexRow = [
  article_number: string,
  description: string,
  net_price: number | null,
  search_values: string[],
];

export type ArticleSearchIndexSnapshot = {
  revision: string;
  rows: ArticleSearchIndexRow[];
  casefold: Record<string, string>;
};

type ArticleSearchIndexResponse =
  | { revision: string; unchanged: true }
  | ArticleSearchIndexSnapshot;

export type ArticleSearchIndex = {
  snapshot: ArticleSearchIndexSnapshot | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  retry: () => void;
};

type ArticleSearchIndexState = Omit<ArticleSearchIndex, "retry"> & { sessionKey: number | string | null };

const ARTICLE_SEARCH_POLL_MS = 5_000;
const PYTHON_STRIP_CODE_POINTS = new Set([
  ...Array.from({ length: 5 }, (_, index) => 0x0009 + index),
  ...Array.from({ length: 5 }, (_, index) => 0x001c + index),
  0x0085, 0x00a0, 0x1680,
  ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function normalizeArticleSearchQuery(query: string, casefold: Record<string, string>): string {
  const characters = Array.from(query);
  let start = 0;
  let end = characters.length;
  while (start < end && PYTHON_STRIP_CODE_POINTS.has(characters[start].codePointAt(0)!)) start += 1;
  while (end > start && PYTHON_STRIP_CODE_POINTS.has(characters[end - 1].codePointAt(0)!)) end -= 1;
  return characters.slice(start, end).map((character) => casefold[character] ?? character).join("");
}

export function searchArticleIndex(snapshot: ArticleSearchIndexSnapshot, query: string, limit = 50): ArticleSummary[] {
  const normalizedQuery = normalizeArticleSearchQuery(query, snapshot.casefold);
  const result: ArticleSummary[] = [];
  const maximum = Math.max(0, Math.floor(limit));
  if (maximum === 0) return result;
  for (const row of snapshot.rows) {
    if (normalizedQuery && !row[3].some((value) => value.includes(normalizedQuery))) continue;
    result.push({ article_number: row[0], description: row[1], net_price: row[2] });
    if (result.length >= maximum) break;
  }
  return result;
}

export function useArticleSearchIndex(
  sessionKey: number | string | null,
  enabled = true,
): ArticleSearchIndex {
  const [state, setState] = useState<ArticleSearchIndexState>(() => initialArticleSearchState(sessionKey));
  const stateRef = useRef(state);
  const requestId = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const updateState = useCallback((updater: (current: ArticleSearchIndexState) => ArticleSearchIndexState) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const cancelRequest = useCallback(() => {
    requestId.current += 1;
    requestController.current?.abort();
    requestController.current = null;
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (requestController.current && !force) return;
    if (force) cancelRequest();

    const controller = new AbortController();
    requestController.current = controller;
    const currentRequest = ++requestId.current;
    const knownRevision = stateRef.current.snapshot?.revision;
    updateState((current) => current.snapshot
      ? current
      : { ...current, loading: true, error: null });

    try {
      const response = await priceRequest<ArticleSearchIndexResponse>(queryPath("/price-comparison/article-search-index", {
        known_revision: knownRevision,
      }), { signal: controller.signal });
      if (currentRequest !== requestId.current) return;

      if (isUnchangedResponse(response)) {
        const currentSnapshot = stateRef.current.snapshot;
        if (!currentSnapshot || response.revision !== currentSnapshot.revision) {
          throw new Error("Der Artikelindex konnte nicht vollständig aktualisiert werden.");
        }
        updateState((current) => current.loading || current.stale || current.error
          ? { ...current, loading: false, stale: false, error: null }
          : current);
        return;
      }

      const snapshot = parseArticleSearchIndex(response);
      updateState((current) => ({ ...current, snapshot, loading: false, stale: false, error: null }));
    } catch (error) {
      if (currentRequest !== requestId.current || isAbortError(error)) return;
      const message = error instanceof Error && error.message
        ? error.message
        : "Der Artikelindex konnte nicht geladen werden.";
      updateState((current) => ({
        ...current,
        loading: false,
        stale: Boolean(current.snapshot),
        error: message,
      }));
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }, [cancelRequest, updateState]);

  useEffect(() => {
    updateState(() => initialArticleSearchState(sessionKey));
    cancelRequest();
  }, [cancelRequest, sessionKey, updateState]);

  useEffect(() => {
    if (!enabled) {
      cancelRequest();
      return;
    }
    let pollTimer: number | null = null;
    const stopPolling = () => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
    };
    const startPolling = () => {
      stopPolling();
      if (document.visibilityState !== "visible") return;
      pollTimer = window.setInterval(() => void refresh(), ARTICLE_SEARCH_POLL_MS);
    };
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      updateState((current) => current.snapshot && !current.stale
        ? { ...current, stale: true }
        : current);
      void refresh(true);
      startPolling();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisible();
      else {
        stopPolling();
        cancelRequest();
      }
    };
    const onPriceDataChanged = () => {
      updateState((current) => current.snapshot && !current.stale
        ? { ...current, stale: true }
        : current);
      if (document.visibilityState === "visible") void refresh(true);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(PRICE_COMPARISON_DATA_CHANGED_EVENT, onPriceDataChanged);
    refreshVisible();
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(PRICE_COMPARISON_DATA_CHANGED_EVENT, onPriceDataChanged);
      cancelRequest();
    };
  }, [cancelRequest, enabled, refresh, sessionKey, updateState]);

  const retry = useCallback(() => void refresh(true), [refresh]);
  const publishedState = state.sessionKey === sessionKey ? state : initialArticleSearchState(sessionKey);
  return useMemo(() => ({
    snapshot: publishedState.snapshot,
    loading: publishedState.loading,
    stale: publishedState.stale,
    error: publishedState.error,
    retry,
  }), [publishedState, retry]);
}

function initialArticleSearchState(sessionKey: number | string | null): ArticleSearchIndexState {
  return { sessionKey, snapshot: null, loading: true, stale: false, error: null };
}

function parseArticleSearchIndex(response: ArticleSearchIndexSnapshot): ArticleSearchIndexSnapshot {
  if (!response || typeof response !== "object" || typeof response.revision !== "string") {
    throw new Error("Der Artikelindex enthält keinen gültigen Datenstand.");
  }
  if (!Array.isArray(response.rows) || !isStringRecord(response.casefold)) {
    throw new Error("Der Artikelindex ist unvollständig.");
  }
  if (!response.rows.every(isArticleSearchIndexRow)) {
    throw new Error("Der Artikelindex enthält ungültige Artikel.");
  }
  return response;
}

function isUnchangedResponse(response: ArticleSearchIndexResponse): response is { revision: string; unchanged: true } {
  return "unchanged" in response && response.unchanged === true;
}

function isArticleSearchIndexRow(value: unknown): value is ArticleSearchIndexRow {
  if (!Array.isArray(value) || value.length !== 4) return false;
  return typeof value[0] === "string"
    && typeof value[1] === "string"
    && (value[2] === null || (typeof value[2] === "number" && Number.isFinite(value[2])))
    && Array.isArray(value[3])
    && value[3].every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
