const MOBILE_BACKGROUND_SCROLL_SELECTORS = [
  ".app-shell.is-mobile-workspace .content-area",
  ".app-shell.is-mobile-workspace .app-main",
  ".app-shell.is-mobile-workspace",
];

export type MobileModalToken = symbol;

export type MobileModalRegistration = {
  token: MobileModalToken;
  release: () => void;
};

type ElementScrollSnapshot = {
  element: HTMLElement;
  overflow: string;
  overscrollBehavior: string;
  scrollLeft: number;
  scrollTop: number;
};

type PageScrollSnapshot = {
  body: {
    left: string;
    overflow: string;
    paddingRight: string;
    position: string;
    top: string;
    width: string;
  };
  bodyHadLockClass: boolean;
  documentElement: {
    overflow: string;
    overscrollBehavior: string;
  };
  documentElementHadLockClass: boolean;
  elements: ElementScrollSnapshot[];
  scrollX: number;
  scrollY: number;
};

const modalStack: MobileModalToken[] = [];
const listeners = new Set<() => void>();
let pageScrollSnapshot: PageScrollSnapshot | null = null;

export function acquireMobileModalLock(token: MobileModalToken = Symbol("mobile-modal")): MobileModalRegistration {
  if (!modalStack.includes(token)) {
    modalStack.push(token);
    if (modalStack.length === 1) {
      lockPageScroll();
    }
    emitStackChange();
  }

  let released = false;
  return {
    token,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      releaseMobileModalLock(token);
    },
  };
}

export function getMobileModalLockCount(): number {
  return modalStack.length;
}

export function getTopMobileModalToken(): MobileModalToken | null {
  return modalStack.at(-1) ?? null;
}

export function subscribeToMobileModalStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function releaseMobileModalLock(token: MobileModalToken): void {
  const tokenIndex = modalStack.lastIndexOf(token);
  if (tokenIndex === -1) {
    return;
  }
  modalStack.splice(tokenIndex, 1);
  if (modalStack.length === 0) {
    unlockPageScroll();
  }
  emitStackChange();
}

function emitStackChange(): void {
  listeners.forEach((listener) => listener());
}

function lockPageScroll(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return;
  }

  const { body, documentElement } = document;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const scrollbarWidth = Math.max(0, window.innerWidth - documentElement.clientWidth);
  const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
  const elements = collectBackgroundScrollElements().map<ElementScrollSnapshot>((element) => ({
    element,
    overflow: element.style.overflow,
    overscrollBehavior: element.style.overscrollBehavior,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
  }));

  pageScrollSnapshot = {
    body: {
      left: body.style.left,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    },
    bodyHadLockClass: body.classList.contains("mobile-modal-scroll-locked"),
    documentElement: {
      overflow: documentElement.style.overflow,
      overscrollBehavior: documentElement.style.overscrollBehavior,
    },
    documentElementHadLockClass: documentElement.classList.contains("mobile-modal-scroll-locked"),
    elements,
    scrollX,
    scrollY,
  };

  documentElement.classList.add("mobile-modal-scroll-locked");
  documentElement.style.overflow = "hidden";
  documentElement.style.overscrollBehavior = "none";
  body.classList.add("mobile-modal-scroll-locked");
  body.style.position = "fixed";
  body.style.top = `${-scrollY}px`;
  body.style.left = `${-scrollX}px`;
  body.style.width = "100%";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;
  }
  elements.forEach(({ element }) => {
    element.style.overflow = "hidden";
    element.style.overscrollBehavior = "none";
  });
}

function unlockPageScroll(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || !pageScrollSnapshot) {
    pageScrollSnapshot = null;
    return;
  }

  const snapshot = pageScrollSnapshot;
  pageScrollSnapshot = null;
  const { body, documentElement } = document;

  body.style.position = snapshot.body.position;
  body.style.top = snapshot.body.top;
  body.style.left = snapshot.body.left;
  body.style.width = snapshot.body.width;
  body.style.overflow = snapshot.body.overflow;
  body.style.paddingRight = snapshot.body.paddingRight;
  documentElement.style.overflow = snapshot.documentElement.overflow;
  documentElement.style.overscrollBehavior = snapshot.documentElement.overscrollBehavior;
  if (!snapshot.bodyHadLockClass) {
    body.classList.remove("mobile-modal-scroll-locked");
  }
  if (!snapshot.documentElementHadLockClass) {
    documentElement.classList.remove("mobile-modal-scroll-locked");
  }
  snapshot.elements.forEach(({ element, overflow, overscrollBehavior, scrollLeft, scrollTop }) => {
    element.style.overflow = overflow;
    element.style.overscrollBehavior = overscrollBehavior;
    element.scrollLeft = scrollLeft;
    element.scrollTop = scrollTop;
  });
  window.scrollTo({
    top: snapshot.scrollY,
    left: snapshot.scrollX,
    behavior: "auto",
  });
}

function collectBackgroundScrollElements(): HTMLElement[] {
  const elements = new Set<HTMLElement>();
  MOBILE_BACKGROUND_SCROLL_SELECTORS.forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => elements.add(element));
  });
  return Array.from(elements);
}
