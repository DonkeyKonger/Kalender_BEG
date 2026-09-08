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

  return <textarea {...props} ref={ref} rows={4} />;
}
