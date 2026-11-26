export type LatestRequestToken = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  finish: () => void;
};

/** Coordinates every load path for one view so a superseded response cannot publish. */
export class LatestRequestGate {
  private requestId = 0;
  private controller: AbortController | null = null;

  begin(): LatestRequestToken {
    this.controller?.abort();
    const controller = new AbortController();
    const requestId = ++this.requestId;
    this.controller = controller;

    return {
      signal: controller.signal,
      isCurrent: () => requestId === this.requestId && !controller.signal.aborted,
      finish: () => {
        if (requestId === this.requestId && this.controller === controller) this.controller = null;
      },
    };
  }

  invalidate(): void {
    this.requestId += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

export function clampPageOffset(offset: number, total: number, limit: number): number {
  if (total <= 0 || limit <= 0) return 0;
  const lastPageOffset = Math.floor((total - 1) / limit) * limit;
  return Math.min(Math.max(0, offset), lastPageOffset);
}
