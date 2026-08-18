import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acquireMobileModalLock,
  getMobileModalLockCount,
  getTopMobileModalToken,
  subscribeToMobileModalStack,
} from "../src/lib/mobileModalScrollLock.ts";


const [timeEntrySource, assignmentDetailSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


function createClassList(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    add: (...values) => values.forEach((value) => classes.add(value)),
    contains: (value) => classes.has(value),
    remove: (...values) => values.forEach((value) => classes.delete(value)),
  };
}


function createElement({ classes = [], scrollLeft = 0, scrollTop = 0, style = {} } = {}) {
  return {
    classList: createClassList(classes),
    scrollLeft,
    scrollTop,
    style: {
      left: "",
      overflow: "",
      overscrollBehavior: "",
      paddingRight: "",
      position: "",
      top: "",
      width: "",
      ...style,
    },
  };
}


test("a stacked modal lock freezes the page once and restores its exact scroll state after the last cleanup", () => {
  assert.equal(getMobileModalLockCount(), 0);
  assert.equal(getTopMobileModalToken(), null);

  const body = createElement({
    style: {
      overflow: "visible",
      paddingRight: "7px",
      position: "relative",
    },
  });
  const documentElement = createElement({
    style: {
      overflow: "clip",
      overscrollBehavior: "auto",
    },
  });
  documentElement.clientWidth = 375;
  const appShell = createElement({ scrollLeft: 3, scrollTop: 41, style: { overflow: "auto" } });
  const appMain = createElement({ scrollLeft: 4, scrollTop: 42, style: { overflow: "scroll" } });
  const contentArea = createElement({ scrollLeft: 5, scrollTop: 43, style: { overflow: "visible" } });
  const elementsBySelector = new Map([
    [".app-shell.is-mobile-workspace", [appShell]],
    [".app-shell.is-mobile-workspace .app-main", [appMain]],
    [".app-shell.is-mobile-workspace .content-area", [contentArea]],
  ]);
  const scrollCalls = [];

  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    getComputedStyle: () => ({ paddingRight: "7px" }),
    innerWidth: 390,
    scrollTo: (options) => scrollCalls.push(options),
    scrollX: 12,
    scrollY: 456,
  };
  globalThis.document = {
    body,
    documentElement,
    querySelectorAll: (selector) => elementsBySelector.get(selector) ?? [],
  };

  const firstToken = Symbol("first");
  const secondToken = Symbol("second");
  const observedTopTokens = [];
  const unsubscribe = subscribeToMobileModalStack(() => observedTopTokens.push(getTopMobileModalToken()));
  let firstRegistration;
  let secondRegistration;

  try {
    firstRegistration = acquireMobileModalLock(firstToken);
    assert.equal(getMobileModalLockCount(), 1);
    assert.equal(getTopMobileModalToken(), firstToken);
    assert.equal(body.style.position, "fixed");
    assert.equal(body.style.top, "-456px");
    assert.equal(body.style.left, "-12px");
    assert.equal(body.style.paddingRight, "22px");
    assert.equal(documentElement.style.overflow, "hidden");
    assert.equal(appShell.style.overflow, "hidden");
    assert.equal(appMain.style.overflow, "hidden");
    assert.equal(contentArea.style.overflow, "hidden");

    secondRegistration = acquireMobileModalLock(secondToken);
    assert.equal(getMobileModalLockCount(), 2);
    assert.equal(getTopMobileModalToken(), secondToken);
    assert.equal(body.style.top, "-456px");

    secondRegistration.release();
    assert.equal(getMobileModalLockCount(), 1);
    assert.equal(getTopMobileModalToken(), firstToken);
    assert.equal(body.style.position, "fixed");
    assert.deepEqual(scrollCalls, []);

    secondRegistration.release();
    assert.equal(getMobileModalLockCount(), 1);

    firstRegistration.release();
    assert.equal(getMobileModalLockCount(), 0);
    assert.equal(getTopMobileModalToken(), null);
    assert.equal(body.style.position, "relative");
    assert.equal(body.style.overflow, "visible");
    assert.equal(body.style.paddingRight, "7px");
    assert.equal(documentElement.style.overflow, "clip");
    assert.equal(documentElement.style.overscrollBehavior, "auto");
    assert.equal(appShell.style.overflow, "auto");
    assert.equal(appMain.style.overflow, "scroll");
    assert.equal(contentArea.style.overflow, "visible");
    assert.deepEqual([appShell.scrollLeft, appShell.scrollTop], [3, 41]);
    assert.deepEqual([appMain.scrollLeft, appMain.scrollTop], [4, 42]);
    assert.deepEqual([contentArea.scrollLeft, contentArea.scrollTop], [5, 43]);
    assert.deepEqual(scrollCalls, [{ top: 456, left: 12, behavior: "auto" }]);
    assert.deepEqual(observedTopTokens, [firstToken, secondToken, firstToken, null]);
  } finally {
    unsubscribe();
    secondRegistration?.release();
    firstRegistration?.release();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});


test("mobile dialogs expose one active stack layer and contain internal scroll chaining", () => {
  assert.match(timeEntrySource, /useMobileModalStack\(sheetMode !== "closed"\)/);
  assert.match(timeEntrySource, /useMobileModalStack\(isBreakPickerOpen && sheetMode !== "closed"\)/);
  assert.match(timeEntrySource, /useMobileModalStack\(timePickerTarget !== null\)/);
  assert.match(timeEntrySource, /data-mobile-modal-active=\{isTimeSheetTopModal\}/);
  assert.match(timeEntrySource, /inert=\{!isTimeSheetTopModal\}/);
  assert.match(assignmentDetailSource, /mobile-measurement-dialog-backdrop mobile-modal-layer/);
  assert.match(assignmentDetailSource, /mobile-customer-signature-overlay mobile-modal-layer mobile-modal-scroll-region/);
  assert.match(styles, /\.mobile-modal-layer\[data-mobile-modal-active="false"\]\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(styles, /\.mobile-modal-scroll-region\s*\{[^}]*overscroll-behavior-y:\s*contain/s);
});


test("the time sheet fills the dynamic safe viewport and only scrolls on real overflow", () => {
  const sharedDialogRule = styles.indexOf(".mobile-project-email-dialog {");
  const timeSheetRule = styles.indexOf(".mobile-project-email-dialog.mobile-time-sheet {");
  assert.ok(sharedDialogRule >= 0);
  assert.ok(timeSheetRule > sharedDialogRule, "the specific time-sheet rule must override the shared 82vh dialog cap");

  const ruleSource = styles.slice(timeSheetRule, styles.indexOf("}", timeSheetRule) + 1);
  assert.match(ruleSource, /max-height:\s*calc\(100dvh[^;]*safe-area-inset-top[^;]*safe-area-inset-bottom[^;]*\)/);
  assert.match(ruleSource, /overflow-y:\s*auto/);
  assert.doesNotMatch(ruleSource, /overflow-y:\s*scroll/);
});
