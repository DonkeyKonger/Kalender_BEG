import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import {
  acquireMobileModalLock,
  getTopMobileModalToken,
  subscribeToMobileModalStack,
  type MobileModalToken,
} from "./mobileModalScrollLock";

export function useMobileModalStack(isOpen: boolean): boolean {
  const tokenRef = useRef<MobileModalToken | null>(null);
  if (tokenRef.current === null) {
    tokenRef.current = Symbol("mobile-modal");
  }
  const topToken = useSyncExternalStore(
    subscribeToMobileModalStack,
    getTopMobileModalToken,
    () => null,
  );

  useLayoutEffect(() => {
    if (!isOpen || tokenRef.current === null) {
      return undefined;
    }
    const registration = acquireMobileModalLock(tokenRef.current);
    return registration.release;
  }, [isOpen]);

  return isOpen && topToken === tokenRef.current;
}
