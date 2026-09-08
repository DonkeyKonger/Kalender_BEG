import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Grow to the CSS height limit; longer notes scroll within the same editor. */
export function ProjectNoteTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      if (!element.clientWidth) return;
      const scrollTop = element.scrollTop;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
      element.scrollTop = scrollTop;
    };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);

  return <textarea {...props} ref={ref} rows={4} onPointerDown={(event) => {
    props.onPointerDown?.(event);
    const element = event.currentTarget;
    if (event.defaultPrevented || event.pointerType !== "mouse" || event.button !== 0
      || element.disabled || document.activeElement === element) return;

    // Focus before the native mouse-down hit test, keeping the clicked text in place.
    // Do not prevent default: caret placement, dragging and double-click selection stay native.
    const { scrollTop, scrollLeft } = element;
    element.focus({ preventScroll: true });
    element.scrollTop = scrollTop;
    element.scrollLeft = scrollLeft;
  }} />;
}
