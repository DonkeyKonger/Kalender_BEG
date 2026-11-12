import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string };

/** A compact select with a square, field-aligned list instead of the OS menu. */
export function MapFilterSelect({ label, value, options, disabled = false, onChange }: {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  const activeIndex = Math.min(active, options.length - 1);
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded]);

  useEffect(() => {
    if (expanded) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, expanded, id]);

  function choose(index: number) {
    if (options[index]) onChange(options[index].value);
    setOpen(false);
  }

  return (
    <div className="site-map-filter" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      <div className="site-map-select">
        <button
          type="button" role="combobox" className="site-map-select-trigger" id={id}
          aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={expanded}
          aria-controls={`${id}-options`} disabled={disabled}
          aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          onClick={() => { setActive(selected); setOpen((current) => !current); search.current.text = ""; }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setOpen(false); return; }
            if (event.key === "Tab") { setOpen(false); return; }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              setActive(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : !expanded ? selected : Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (expanded) choose(activeIndex);
              else { setActive(selected); setOpen(true); }
            } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const now = Date.now();
              search.current.text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase("de");
              search.current.time = now;
              const match = options.findIndex((option) => option.label.toLocaleLowerCase("de").startsWith(search.current.text));
              if (match >= 0) { setOpen(true); setActive(match); }
            }
          }}
        >
          <span>{options[selected]?.label ?? "Alle"}</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        {expanded && <div className="site-map-select-options" role="listbox" id={`${id}-options`} aria-labelledby={`${id}-label`}>
          {options.map((option, index) => (
            <button
              key={option.value} id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1}
              aria-selected={option.value === value} className={index === activeIndex ? "is-active" : ""}
              onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}
            >
              <span>{option.label}</span>{option.value === value && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>}
      </div>
    </div>
  );
}
