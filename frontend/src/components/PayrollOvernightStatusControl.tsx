import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getOvernightStatusPresentation } from "../lib/overnightStatus";
import { resolveViewportPopoverPosition, type ViewportPopoverPosition } from "../lib/viewportPopover";
import type { OvernightStatus } from "../types/timeEntry";
import { OvernightStatusIndicator } from "./OvernightStatusIndicator";


type PayrollOvernightStatusControlProps = {
  editable: boolean;
  saving: boolean;
  status: OvernightStatus | null;
  onChange: (status: OvernightStatus) => Promise<void>;
};

type PayrollOvernightPopoverState = {
  triggerTop: number;
  triggerBottom: number;
  triggerLeft: number;
  position: ViewportPopoverPosition | null;
};

const PAYROLL_OVERNIGHT_OPTIONS: Array<{ status: OvernightStatus; label: string }> = [
  { status: "none", label: "Keine Übernachtung" },
  { status: "self_paid", label: "Hotel selbst bezahlt" },
  { status: "beg_paid", label: "Hotel durch BEG bezahlt" },
];


export function PayrollOvernightStatusControl({
  editable,
  saving,
  status,
  onChange,
}: PayrollOvernightStatusControlProps) {
  const [popover, setPopover] = useState<PayrollOvernightPopoverState | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const presentation = getOvernightStatusPresentation(status);

  useEffect(() => {
    if (!editable) {
      setPopover(null);
    }
  }, [editable]);

  useEffect(() => {
    if (!popover) {
      return undefined;
    }

    function closeOnPointerDown(event: PointerEvent): void {
      if (
        event.target instanceof Node
        && (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target))
      ) {
        return;
      }
      setPopover(null);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setPopover(null);
        triggerRef.current?.focus();
      }
    }

    function closeOnViewportChange(): void {
      setPopover(null);
    }

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [popover]);

  useLayoutEffect(() => {
    if (!popover || popover.position || !menuRef.current) {
      return;
    }
    const bounds = menuRef.current.getBoundingClientRect();
    const position = resolveViewportPopoverPosition({
      triggerTop: popover.triggerTop,
      triggerBottom: popover.triggerBottom,
      triggerLeft: popover.triggerLeft,
      menuWidth: Math.max(bounds.width, menuRef.current.scrollWidth),
      menuHeight: menuRef.current.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPopover((current) => (
      current && current.position === null ? { ...current, position } : current
    ));
  }, [popover]);

  function togglePopover(): void {
    if (!editable || saving || !triggerRef.current) {
      return;
    }
    setPopover((current) => {
      if (current) {
        return null;
      }
      const rect = triggerRef.current?.getBoundingClientRect();
      return rect ? {
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
        triggerLeft: rect.left,
        position: null,
      } : null;
    });
  }

  async function selectStatus(nextStatus: OvernightStatus): Promise<void> {
    if (saving) {
      return;
    }
    if (nextStatus === status) {
      setPopover(null);
      return;
    }
    try {
      await onChange(nextStatus);
    } finally {
      setPopover(null);
    }
  }

  if (!editable) {
    return <OvernightStatusIndicator status={status} />;
  }

  return (
    <>
      <button
        aria-expanded={popover !== null}
        aria-haspopup="menu"
        aria-label={`Übernachtungsstatus ändern: ${presentation.label}`}
        className="time-review-overnight-trigger"
        disabled={saving}
        ref={triggerRef}
        type="button"
        onClick={togglePopover}
      >
        <span aria-hidden="true"><OvernightStatusIndicator status={status} /></span>
      </button>
      {popover && typeof document !== "undefined" && createPortal(
        <div
          aria-busy={saving}
          aria-label="Übernachtungsstatus auswählen"
          className={`time-review-day-move-popover time-review-overnight-popover${popover.position ? ` is-open-${popover.position.placement}` : ""}`}
          ref={menuRef}
          role="menu"
          style={{
            left: `${popover.position?.left ?? popover.triggerLeft}px`,
            top: `${popover.position?.top ?? popover.triggerBottom + 4}px`,
            maxHeight: popover.position ? `${popover.position.maxHeight}px` : undefined,
            maxWidth: popover.position ? `${popover.position.maxWidth}px` : undefined,
            visibility: popover.position ? "visible" : "hidden",
          }}
        >
          {PAYROLL_OVERNIGHT_OPTIONS.map((option) => {
            const isSelected = status === option.status;
            return (
              <button
                aria-checked={isSelected}
                aria-label={option.label}
                className={isSelected ? "is-selected" : ""}
                disabled={saving}
                key={option.status}
                role="menuitemradio"
                type="button"
                onClick={() => void selectStatus(option.status)}
              >
                <span aria-hidden="true"><OvernightStatusIndicator status={option.status} /></span>
                <span>{option.label}</span>
                <span className="time-review-overnight-option-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
