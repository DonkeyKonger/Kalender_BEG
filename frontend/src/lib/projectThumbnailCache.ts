/** Short-lived, bounded cache of authenticated previews, never original files. */
export function createProjectThumbnailCache(maxBytes = 16 * 1024 * 1024, maxEntries = 128, ttlMs = 60_000) {
  let scope: string | null = null;
  let generation = 0;
  let bytes = 0;
  const cached = new Map<string, { blob: Blob; expires: number }>();
  const pending = new Map<string, Promise<Blob>>();

  function clear() {
    generation++;
    cached.clear();
    pending.clear();
    bytes = 0;
  }

  function remove(key: string) {
    bytes -= cached.get(key)?.blob.size ?? 0;
    cached.delete(key);
  }

  function load(authScope: string | null, key: string, loader: () => Promise<Blob>, retain = true): Promise<Blob> {
    if (scope !== authScope) {
      clear();
      scope = authScope;
    }
    if (!authScope) return loader();
    const now = Date.now();
    for (const [id, entry] of cached) if (entry.expires <= now) remove(id);
    const hit = cached.get(key);
    if (hit) {
      cached.delete(key);
      cached.set(key, hit);
      return Promise.resolve(hit.blob);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const requestGeneration = generation;
    const request = Promise.resolve().then(loader).then(blob => {
      if (requestGeneration === generation && retain && blob.size <= maxBytes) {
        cached.set(key, { blob, expires: Date.now() + ttlMs });
        bytes += blob.size;
        while (bytes > maxBytes || cached.size > maxEntries) remove(cached.keys().next().value!);
      }
      return blob;
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  }

  return { load, clear };
}

export const projectThumbnailCache = createProjectThumbnailCache();
