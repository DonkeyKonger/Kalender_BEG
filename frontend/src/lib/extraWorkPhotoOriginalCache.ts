export type ExtraWorkOriginalPhotoLoader = (signal: AbortSignal) => Promise<Blob>;

type CachedOriginal = {
  blob?: Blob;
  controller?: AbortController;
  promise?: Promise<Blob>;
  touchedAt: number;
};

export type NetworkInformationLike = {
  effectiveType?: string;
  saveData?: boolean;
};

export class ExtraWorkPhotoOriginalCache {
  private readonly entries = new Map<number, CachedOriginal>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor({ maxBytes = 40 * 1024 * 1024, maxEntries = 5 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  get(photoId: number): Blob | null {
    const entry = this.entries.get(photoId);
    if (!entry?.blob) {
      return null;
    }
    entry.touchedAt = Date.now();
    return entry.blob;
  }

  contains(photoId: number): boolean {
    return this.entries.has(photoId);
  }

  abort(photoId: number): void {
    const entry = this.entries.get(photoId);
    entry?.controller?.abort();
    this.entries.delete(photoId);
  }

  load(photoId: number, loader: ExtraWorkOriginalPhotoLoader): Promise<Blob> {
    const existing = this.entries.get(photoId);
    if (existing?.blob) {
      existing.touchedAt = Date.now();
      return Promise.resolve(existing.blob);
    }
    if (existing?.promise) {
      return existing.promise;
    }
    const controller = new AbortController();
    const entry: CachedOriginal = { controller, touchedAt: Date.now() };
    const promise = loader(controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        entry.blob = blob;
        entry.controller = undefined;
        entry.promise = undefined;
        entry.touchedAt = Date.now();
        this.trim(photoId);
        return blob;
      })
      .catch((error) => {
        if (this.entries.get(photoId) === entry) {
          this.entries.delete(photoId);
        }
        throw error;
      });
    entry.promise = promise;
    this.entries.set(photoId, entry);
    return promise;
  }

  retain(photoIds: Iterable<number>): void {
    const retained = new Set(photoIds);
    for (const [photoId, entry] of this.entries) {
      if (!retained.has(photoId)) {
        entry.controller?.abort();
        this.entries.delete(photoId);
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
    }
    this.entries.clear();
  }

  private trim(protectedPhotoId: number): void {
    const completed = () => [...this.entries.entries()].filter(([, entry]) => entry.blob);
    const totalBytes = () => completed().reduce((sum, [, entry]) => sum + (entry.blob?.size ?? 0), 0);
    while (completed().length > this.maxEntries || totalBytes() > this.maxBytes) {
      const candidate = completed()
        .filter(([photoId]) => photoId !== protectedPhotoId)
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!candidate) {
        break;
      }
      this.entries.delete(candidate[0]);
    }
  }
}

export function shouldPrefetchExtraWorkOriginalPhotos(
  connection: NetworkInformationLike | null | undefined,
): boolean {
  if (connection?.saveData) {
    return false;
  }
  return !new Set(["slow-2g", "2g"]).has(connection?.effectiveType ?? "");
}

export function orderExtraWorkOriginalPhotoIds(
  photoIds: number[],
  prioritizedPhotoId?: number | null,
): number[] {
  const unique = [...new Set(photoIds)];
  if (prioritizedPhotoId == null || !unique.includes(prioritizedPhotoId)) {
    return unique;
  }
  return [prioritizedPhotoId, ...unique.filter((photoId) => photoId !== prioritizedPhotoId)];
}
