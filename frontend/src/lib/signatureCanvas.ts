import type { CustomerSignaturePoint, CustomerSignatureStroke } from "../types/site";

export const SIGNATURE_SOURCE_ASPECT_RATIO = 3;
export const SIGNATURE_SVG_WIDTH = 1200;
export const SIGNATURE_SVG_HEIGHT = SIGNATURE_SVG_WIDTH / SIGNATURE_SOURCE_ASPECT_RATIO;

export function getNormalizedSignaturePoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): CustomerSignaturePoint | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: clampSignatureCoordinate((clientX - rect.left) / rect.width),
    y: clampSignatureCoordinate((clientY - rect.top) / rect.height),
  };
}

export function drawSignatureCanvas(
  canvas: HTMLCanvasElement | null,
  strokes: CustomerSignatureStroke[],
): void {
  if (!canvas) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const width = Math.max(1, Math.floor(rect.width * pixelRatio));
  const height = Math.max(1, Math.floor(rect.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    return;
  }
  context.clearRect(0, 0, width, height);
  context.save();
  context.scale(pixelRatio, pixelRatio);
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#0f2747";
  for (const stroke of strokes) {
    const points = stroke.filter(isFiniteSignaturePoint);
    if (points.length < 2) {
      continue;
    }
    const firstPoint = points[0];
    if (!firstPoint) {
      continue;
    }
    context.beginPath();
    context.moveTo(firstPoint.x * rect.width, firstPoint.y * rect.height);
    for (const point of points.slice(1)) {
      context.lineTo(point.x * rect.width, point.y * rect.height);
    }
    context.stroke();
  }
  context.restore();
}

export function signatureStrokeToSvgPoints(stroke: CustomerSignatureStroke): string {
  return stroke
    .filter(isFiniteSignaturePoint)
    .map((point) => (
      `${clampSignatureCoordinate(point.x) * SIGNATURE_SVG_WIDTH},${clampSignatureCoordinate(point.y) * SIGNATURE_SVG_HEIGHT}`
    ))
    .join(" ");
}

export function validSignatureStrokes(
  strokes: CustomerSignatureStroke[] | null | undefined,
): CustomerSignatureStroke[] {
  return (strokes ?? [])
    .map((stroke) => stroke.filter(isFiniteSignaturePoint))
    .filter((stroke) => stroke.length >= 2);
}

function isFiniteSignaturePoint(point: CustomerSignaturePoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function clampSignatureCoordinate(value: number): number {
  return Math.min(1, Math.max(0, value));
}
