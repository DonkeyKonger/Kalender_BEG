export const EXTRA_WORK_PHOTO_MIN_ZOOM = 1;
export const EXTRA_WORK_PHOTO_MAX_ZOOM = 4;
export const EXTRA_WORK_PHOTO_ZOOM_STEP = 0.25;

export type ExtraWorkPhotoPoint = {
  x: number;
  y: number;
};

export function clampExtraWorkPhotoZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return EXTRA_WORK_PHOTO_MIN_ZOOM;
  }
  return Math.min(EXTRA_WORK_PHOTO_MAX_ZOOM, Math.max(EXTRA_WORK_PHOTO_MIN_ZOOM, value));
}

export function stepExtraWorkPhotoZoom(current: number, direction: -1 | 1): number {
  return clampExtraWorkPhotoZoom(current + (direction * EXTRA_WORK_PHOTO_ZOOM_STEP));
}

export function getExtraWorkPhotoWheelZoom(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return clampExtraWorkPhotoZoom(current);
  }
  const factor = Math.exp(-deltaY * 0.0025);
  return clampExtraWorkPhotoZoom(current * factor);
}

export function clampExtraWorkPhotoPan(
  point: ExtraWorkPhotoPoint,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
): ExtraWorkPhotoPoint {
  const normalizedZoom = clampExtraWorkPhotoZoom(zoom);
  if (normalizedZoom <= EXTRA_WORK_PHOTO_MIN_ZOOM) {
    return { x: 0, y: 0 };
  }
  const maxX = Math.max(0, viewportWidth * (normalizedZoom - 1) / 2);
  const maxY = Math.max(0, viewportHeight * (normalizedZoom - 1) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, point.x)),
    y: Math.min(maxY, Math.max(-maxY, point.y)),
  };
}

export function getExtraWorkPhotoPointerDistance(
  first: ExtraWorkPhotoPoint,
  second: ExtraWorkPhotoPoint,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function getExtraWorkPhotoPointerCenter(
  first: ExtraWorkPhotoPoint,
  second: ExtraWorkPhotoPoint,
): ExtraWorkPhotoPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}
