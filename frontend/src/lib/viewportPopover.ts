export type ViewportPopoverPlacement = "above" | "below";

export type ViewportPopoverPosition = {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
  placement: ViewportPopoverPlacement;
};

type ViewportPopoverPositionInput = {
  triggerTop: number;
  triggerBottom: number;
  triggerLeft: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportPadding?: number;
  gap?: number;
};

export function resolveViewportPopoverPosition({
  triggerTop,
  triggerBottom,
  triggerLeft,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  viewportPadding = 8,
  gap = 4,
}: ViewportPopoverPositionInput): ViewportPopoverPosition {
  const maxWidth = Math.max(0, viewportWidth - viewportPadding * 2);
  const renderedWidth = Math.min(menuWidth, maxWidth);
  const largestLeft = Math.max(viewportPadding, viewportWidth - viewportPadding - renderedWidth);
  const left = Math.max(viewportPadding, Math.min(triggerLeft, largestLeft));
  const spaceBelow = Math.max(0, viewportHeight - viewportPadding - triggerBottom - gap);
  const spaceAbove = Math.max(0, triggerTop - gap - viewportPadding);

  if (spaceBelow >= menuHeight) {
    return {
      left,
      top: triggerBottom + gap,
      maxHeight: spaceBelow,
      maxWidth,
      placement: "below",
    };
  }

  if (spaceAbove >= menuHeight) {
    return {
      left,
      top: triggerTop - gap - menuHeight,
      maxHeight: spaceAbove,
      maxWidth,
      placement: "above",
    };
  }

  if (spaceBelow >= spaceAbove) {
    return {
      left,
      top: triggerBottom + gap,
      maxHeight: spaceBelow,
      maxWidth,
      placement: "below",
    };
  }

  return {
    left,
    top: viewportPadding,
    maxHeight: spaceAbove,
    maxWidth,
    placement: "above",
  };
}
