import type { MobileExtraWorkTicketPhoto } from "../types/site";

export const MAX_EXTRA_WORK_OVERVIEW_PHOTOS = 5;

const photoListLoaders = new Map<string, Promise<MobileExtraWorkTicketPhoto[]>>();
const thumbnailLoaders = new Map<string, Promise<Blob>>();

export function getExtraWorkOverviewPhotoSlots(
  photos: MobileExtraWorkTicketPhoto[],
): Array<MobileExtraWorkTicketPhoto | null> {
  return Array.from(
    { length: MAX_EXTRA_WORK_OVERVIEW_PHOTOS },
    (_, index) => photos[index] ?? null,
  );
}

export function loadExtraWorkOverviewPhotoList(
  siteId: number,
  ticketId: number,
  includeDeleted: boolean,
  loader: () => Promise<MobileExtraWorkTicketPhoto[]>,
): Promise<MobileExtraWorkTicketPhoto[]> {
  const key = `${siteId}:${ticketId}:${includeDeleted ? "deleted" : "active"}`;
  const existing = photoListLoaders.get(key);
  if (existing) {
    return existing;
  }
  const request = loader()
    .then((photos) => photos.slice(0, MAX_EXTRA_WORK_OVERVIEW_PHOTOS))
    .finally(() => {
      if (photoListLoaders.get(key) === request) {
        photoListLoaders.delete(key);
      }
    });
  photoListLoaders.set(key, request);
  return request;
}

export function loadExtraWorkOverviewThumbnail(
  siteId: number,
  ticketId: number,
  photoId: number,
  includeDeleted: boolean,
  loader: () => Promise<Blob>,
): Promise<Blob> {
  const key = `${siteId}:${ticketId}:${photoId}:${includeDeleted ? "deleted" : "active"}`;
  const existing = thumbnailLoaders.get(key);
  if (existing) {
    return existing;
  }
  const request = loader().catch((error) => {
    if (thumbnailLoaders.get(key) === request) {
      thumbnailLoaders.delete(key);
    }
    throw error;
  });
  thumbnailLoaders.set(key, request);
  return request;
}
