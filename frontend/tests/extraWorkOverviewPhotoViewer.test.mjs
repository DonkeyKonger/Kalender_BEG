import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTRA_WORK_PHOTO_MAX_ZOOM,
  EXTRA_WORK_PHOTO_MIN_ZOOM,
  clampExtraWorkPhotoPan,
  clampExtraWorkPhotoZoom,
  getExtraWorkPhotoPointerCenter,
  getExtraWorkPhotoPointerDistance,
  getExtraWorkPhotoSafariGestureZoom,
  getExtraWorkPhotoWheelZoom,
  resolveExtraWorkPhotoWheelGesture,
  stepExtraWorkPhotoZoom,
} from "../src/lib/extraWorkPhotoViewer.ts";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

const modalStart = pageSource.indexOf("function ExtraWorkOverviewPhotoModal");
const modalSource = pageSource.slice(modalStart, pageSource.indexOf("function MeasurementTab", modalStart));

test("zoom helpers enforce 1x to 4x bounds for buttons, wheel and trackpad gestures", () => {
  assert.equal(clampExtraWorkPhotoZoom(-8), EXTRA_WORK_PHOTO_MIN_ZOOM);
  assert.equal(clampExtraWorkPhotoZoom(9), EXTRA_WORK_PHOTO_MAX_ZOOM);
  assert.equal(clampExtraWorkPhotoZoom(Number.NaN), EXTRA_WORK_PHOTO_MIN_ZOOM);
  assert.equal(stepExtraWorkPhotoZoom(1, 1), 1.25);
  assert.equal(stepExtraWorkPhotoZoom(4, 1), 4);
  assert.equal(stepExtraWorkPhotoZoom(1, -1), 1);
  assert.ok(getExtraWorkPhotoWheelZoom(2, -100) > 2);
  assert.ok(getExtraWorkPhotoWheelZoom(2, 100) < 2);
  assert.equal(getExtraWorkPhotoWheelZoom(4, -100), 4);
});

test("small Mac ctrl-wheel pinch deltas are accumulated and always capture browser zoom", () => {
  const interactions = [-0.08, -0.12, -0.2].map((deltaY) => ({
    ctrlKey: true,
    deltaMode: 0,
    deltaY,
  }));
  let zoom = 1;
  for (const input of interactions) {
    const result = resolveExtraWorkPhotoWheelGesture(zoom, input);
    assert.equal(result.preventDefault, true);
    assert.ok(result.nextZoom > zoom);
    zoom = result.nextZoom;
  }
  assert.ok(zoom > 1.003);
  assert.deepEqual(
    resolveExtraWorkPhotoWheelGesture(4, { ctrlKey: true, deltaY: -0.1 }),
    { nextZoom: 4, preventDefault: true },
  );
});

test("mouse wheel and ordinary two-finger scroll zoom only while the image can change", () => {
  const mouseWheel = resolveExtraWorkPhotoWheelGesture(1, { deltaMode: 1, deltaY: -3 });
  assert.ok(mouseWheel.nextZoom > 1);
  assert.equal(mouseWheel.preventDefault, true);

  const trackpadScroll = resolveExtraWorkPhotoWheelGesture(2, { deltaMode: 0, deltaY: 0.5 });
  assert.ok(trackpadScroll.nextZoom < 2);
  assert.equal(trackpadScroll.preventDefault, true);

  assert.deepEqual(
    resolveExtraWorkPhotoWheelGesture(1, { deltaY: 1 }),
    { nextZoom: 1, preventDefault: false },
  );
  assert.deepEqual(
    resolveExtraWorkPhotoWheelGesture(4, { deltaY: -1 }),
    { nextZoom: 4, preventDefault: false },
  );
});

test("Safari gesture scale follows the captured start zoom and stays bounded", () => {
  assert.ok(Math.abs(getExtraWorkPhotoSafariGestureZoom(1.5, 1.2) - 1.8) < 0.0001);
  assert.equal(getExtraWorkPhotoSafariGestureZoom(3, 2), 4);
  assert.equal(getExtraWorkPhotoSafariGestureZoom(2, 0.1), 1);
  assert.equal(getExtraWorkPhotoSafariGestureZoom(2, Number.NaN), 2);
});

test("pan and pinch geometry keeps a zoomed image reachable", () => {
  assert.deepEqual(clampExtraWorkPhotoPan({ x: 99, y: -99 }, 1, 400, 300), { x: 0, y: 0 });
  assert.deepEqual(clampExtraWorkPhotoPan({ x: 999, y: -999 }, 2, 400, 300), { x: 200, y: -150 });
  assert.equal(getExtraWorkPhotoPointerDistance({ x: 0, y: 0 }, { x: 30, y: 40 }), 50);
  assert.deepEqual(getExtraWorkPhotoPointerCenter({ x: 10, y: 20 }, { x: 30, y: 60 }), { x: 20, y: 40 });
});

test("fixed previous and next controls navigate only real photos and disable at the ends", () => {
  assert.match(modalSource, /const activePhoto = photos\[activePhotoIndex\] \?\? photos\[0\]/);
  assert.match(modalSource, /const canShowPrevious = activePhotoIndex > 0/);
  assert.match(modalSource, /const canShowNext = activePhotoIndex < photos\.length - 1/);
  assert.match(modalSource, /Math\.min\(photos\.length - 1, Math\.max\(0, current \+ direction\)\)/);
  assert.match(modalSource, /aria-label="Vorheriges Foto"[\s\S]*disabled=\{!canShowPrevious\}/);
  assert.match(modalSource, /aria-label="Nächstes Foto"[\s\S]*disabled=\{!canShowNext\}/);
  assert.match(modalSource, /event\.key === "ArrowLeft"[\s\S]*navigatePhoto\(-1\)/);
  assert.match(modalSource, /event\.key === "ArrowRight"[\s\S]*navigatePhoto\(1\)/);
  assert.match(styles, /\.project-extra-work-photo-modal-nav \{[^}]*position:\s*absolute;[^}]*top:\s*50%;/s);
});

test("navigation updates filename and alt text while loading just the active original", () => {
  assert.match(modalSource, /title=\{activePhoto\.filename\}>\{activePhoto\.filename\}/);
  assert.match(modalSource, /activePhoto\.caption\?\.trim\(\)[\s\S]*activePhoto\.filename/);
  assert.match(modalSource, /originalPhotoCache\.load\(activePhoto\.id/);
  assert.match(modalSource, /siteExtraWorkTicketPhotoContent[\s\S]*activePhoto\.id/);
  assert.match(modalSource, /\[activePhoto\.id, includeDeleted, originalPhotoCache, resetViewer, siteId, ticketId\]/);
  assert.doesNotMatch(modalSource, /Promise\.all/);
  assert.match(modalSource, /originalPhotoCache\.abort\(activePhoto\.id\)/);
  assert.match(modalSource, /window\.URL\.revokeObjectURL\(objectUrl\)/);
});

test("wheel, Safari gesture, pointer pinch and dragging stay scoped to the loaded image stage", () => {
  assert.match(modalSource, /const handleWheel = useCallback[\s\S]*resolveExtraWorkPhotoWheelGesture[\s\S]*event\.preventDefault\(\)[\s\S]*updateZoom/);
  assert.match(modalSource, /event\.target instanceof Element && event\.target\.closest\("button"\)/);
  assert.match(modalSource, /handleSafariGestureStart[\s\S]*event\.preventDefault\(\)[\s\S]*safariGestureStartZoomRef\.current = zoomRef\.current/);
  assert.match(modalSource, /handleSafariGestureChange[\s\S]*getExtraWorkPhotoSafariGestureZoom\(startZoom, scale\)/);
  assert.match(modalSource, /pointerPositionsRef\.current\.set\(event\.pointerId, pointer\)/);
  assert.match(modalSource, /getExtraWorkPhotoPointerDistance[\s\S]*pinchGestureRef\.current/);
  assert.match(modalSource, /handlePointerMove[\s\S]*updatePan/);
  assert.match(modalSource, /const listenerOptions = \{ capture: true, passive: false \} as const/);
  assert.match(modalSource, /addEventListener\("wheel", handleWheel, listenerOptions\)/);
  assert.match(modalSource, /addEventListener\("gesturestart", handleSafariGestureStart, listenerOptions\)/);
  assert.match(modalSource, /addEventListener\("gesturechange", handleSafariGestureChange, listenerOptions\)/);
  assert.match(modalSource, /removeEventListener\("wheel", handleWheel, listenerOptions\)/);
  assert.match(modalSource, /removeEventListener\("gestureend", handleSafariGestureEnd, listenerOptions\)/);
  assert.match(modalSource, /onPointerCancel=\{finishPointerGesture\}[\s\S]*onPointerUp=\{finishPointerGesture\}/);
  assert.match(styles, /\.project-extra-work-photo-modal-stage\.is-interactive \{[^}]*touch-action:\s*none;/s);
  assert.match(styles, /\.project-extra-work-photo-modal-stage\.is-zoomed \{[^}]*cursor:\s*grab;/s);
});

test("accessible zoom controls and every image change reset to contain", () => {
  assert.match(modalSource, /aria-label="Verkleinern"/);
  assert.match(modalSource, /aria-label=\{`Zoom zurücksetzen, aktuell \$\{Math\.round\(zoom \* 100\)\} Prozent`\}/);
  assert.match(modalSource, /aria-label="Vergrößern"/);
  assert.match(modalSource, /resetViewer\(\);[\s\S]*setImageUrl\(null\)/);
  assert.match(modalSource, /if \(next !== current\) \{[\s\S]*resetViewer\(\)/);
  assert.match(modalSource, /setZoom\(EXTRA_WORK_PHOTO_MIN_ZOOM\)[\s\S]*setPan\(\{ x: 0, y: 0 \}\)/);
  assert.match(styles, /\.project-extra-work-photo-modal-stage img \{[^}]*object-fit:\s*contain;[^}]*transform-origin:\s*center;/s);
});

test("the taller dialog keeps width, header, close button and controls spatially fixed", () => {
  assert.match(styles, /\.project-extra-work-photo-modal \{[^}]*width:\s*clamp\(420px, 56vw, 920px\);[^}]*height:\s*clamp\(450px, 72\.5dvh, 900px\);[^}]*max-height:\s*calc\(100dvh - 64px\);/s);
  assert.match(styles, /\.project-extra-work-photo-modal \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.project-extra-work-photo-modal-close \{[^}]*width:\s*38px;[^}]*height:\s*38px;[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.project-extra-work-photo-modal-nav\.is-previous \{[^}]*left:\s*12px;/s);
  assert.match(styles, /\.project-extra-work-photo-modal-nav\.is-next \{[^}]*right:\s*12px;/s);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*height:\s*min\(92dvh, calc\(100dvh - 28px\)\);/s);
});

test("the expanded focus trap includes navigation and zoom without moving initial focus", () => {
  assert.match(modalSource, /requestAnimationFrame\(\(\) => closeButtonRef\.current\?\.focus\(\)\)/);
  assert.match(modalSource, /querySelectorAll<HTMLElement>[\s\S]*button:not\(:disabled\)/);
  assert.match(modalSource, /document\.activeElement === first[\s\S]*last\.focus\(\)/);
  assert.match(modalSource, /document\.activeElement === last[\s\S]*first\.focus\(\)/);
  assert.match(modalSource, /aria-describedby=\{descriptionId\}/);
});
