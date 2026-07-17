import { useLayoutEffect } from "react";

const MOBILE_SCROLL_CONTAINER_SELECTORS = [
  ".app-shell.is-mobile-workspace .content-area",
  ".app-shell.is-mobile-workspace .app-main",
  ".app-shell.is-mobile-workspace",
];

type MobileScrollTarget = HTMLElement | Window;

export function useMobileScrollReset(resetKey: unknown, enabled = true): void {
  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    resetMobileScrollPosition();
    const frameId = window.requestAnimationFrame(resetMobileScrollPosition);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [enabled, resetKey]);
}

export function resetMobileScrollPosition(): void {
  getMobileScrollTargets().forEach((target) => {
    if (isWindowTarget(target)) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }

    target.scrollTop = 0;
    target.scrollLeft = 0;
  });
}

function getMobileScrollTargets(): MobileScrollTarget[] {
  const targets = new Set<MobileScrollTarget>();

  MOBILE_SCROLL_CONTAINER_SELECTORS.forEach((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) {
      return;
    }
    if (isScrollableElement(element) || element.scrollTop !== 0 || element.scrollLeft !== 0) {
      targets.add(element);
    }
  });

  const scrollingElement = document.scrollingElement;
  if (scrollingElement instanceof HTMLElement) {
    targets.add(scrollingElement);
  }
  targets.add(document.documentElement);
  if (document.body) {
    targets.add(document.body);
  }
  targets.add(window);

  return Array.from(targets);
}

function isScrollableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY;
  const canScrollY = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";

  return canScrollY && element.scrollHeight > element.clientHeight;
}

function isWindowTarget(target: MobileScrollTarget): target is Window {
  return target === window;
}
