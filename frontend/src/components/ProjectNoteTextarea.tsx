import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Fit project notes to their content without replacing the focused editor. */
export function ProjectNoteTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      if (!element.clientWidth) return;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
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
