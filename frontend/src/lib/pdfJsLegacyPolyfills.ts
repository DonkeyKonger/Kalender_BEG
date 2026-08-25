type PromiseCapability<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseCapability<T>;
};

type MapWithComputed<K, V> = Map<K, V> & {
  getOrInsertComputed?: (key: K, callback: (key: K) => V) => V;
};

type MapConstructorWithComputed = MapConstructor & {
  prototype: MapWithComputed<unknown, unknown>;
};

type URLConstructorWithParse = typeof URL & {
  parse?: (url: string | URL, base?: string | URL) => URL | null;
};

type AbortSignalConstructorWithAny = typeof AbortSignal & {
  any?: (signals: Iterable<AbortSignal>) => AbortSignal;
};

type PdfJsCompatibilityScope = {
  Promise: PromiseConstructorWithResolvers;
  Map: MapConstructorWithComputed;
  URL: URLConstructorWithParse;
  AbortController?: typeof AbortController;
  AbortSignal?: AbortSignalConstructorWithAny;
};

export function installPdfJsLegacyCompatibility(
  scope: PdfJsCompatibilityScope = globalThis as unknown as PdfJsCompatibilityScope,
): void {
  if (typeof scope.Promise.withResolvers !== "function") {
    Object.defineProperty(scope.Promise, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers<T>(): PromiseCapability<T> {
        let resolve!: PromiseCapability<T>["resolve"];
        let reject!: PromiseCapability<T>["reject"];
        const promise = new scope.Promise<T>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        return { promise, resolve, reject };
      },
    });
  }

  if (typeof scope.Map.prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(scope.Map.prototype, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed<K, V>(
        this: Map<K, V>,
        key: K,
        callback: (key: K) => V,
      ): V {
        if (this.has(key)) {
          return this.get(key) as V;
        }
        const value = callback(key);
        this.set(key, value);
        return value;
      },
    });
  }

  if (typeof scope.URL.parse !== "function") {
    Object.defineProperty(scope.URL, "parse", {
      configurable: true,
      writable: true,
      value: (url: string | URL, base?: string | URL): URL | null => {
        try {
          return base === undefined ? new scope.URL(url) : new scope.URL(url, base);
        } catch {
          return null;
        }
      },
    });
  }

  if (
    scope.AbortSignal
    && scope.AbortController
    && typeof scope.AbortSignal.any !== "function"
  ) {
    Object.defineProperty(scope.AbortSignal, "any", {
      configurable: true,
      writable: true,
      value: (signals: Iterable<AbortSignal>): AbortSignal => {
        const controller = new scope.AbortController!();
        const cleanups: Array<() => void> = [];
        const abortFrom = (signal: AbortSignal) => {
          for (const cleanup of cleanups) {
            cleanup();
          }
          if (controller.signal.aborted) {
            return;
          }
          try {
            controller.abort("reason" in signal ? signal.reason : undefined);
          } catch {
            controller.abort();
          }
        };

        for (const signal of signals) {
          if (signal.aborted) {
            abortFrom(signal);
            break;
          }
          const handleAbort = () => abortFrom(signal);
          signal.addEventListener("abort", handleAbort, { once: true });
          cleanups.push(() => signal.removeEventListener("abort", handleAbort));
        }
        return controller.signal;
      },
    });
  }
}
