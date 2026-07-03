import { useState } from "react";

type SiteColorOption = { name: string; value: string };

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Blau", value: "#2563EB" },
  { name: "Dunkelblau", value: "#1E40AF" },
  { name: "Gruen", value: "#16A34A" },
  { name: "Rot", value: "#DC2626" },
  { name: "Orange", value: "#F97316" },
  { name: "Ocker", value: "#D97706" },
  { name: "Tuerkis", value: "#0891B2" },
  { name: "Violett", value: "#7C3AED" },
  { name: "Magenta", value: "#DB2777" },
  { name: "Grau", value: "#64748B" },
];

export function SiteColorSelect({
  className,
  disabled,
  hideLabel = false,
  label = "Farbe",
  value,
  onChange,
}: {
  className?: string;
  disabled?: boolean;
  hideLabel?: boolean;
  label?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption = SITE_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === value.toLowerCase());
  const selectedLabel = selectedOption?.name ?? label;

  return (
    <div className={["site-color-select-field site-field-color", className].filter(Boolean).join(" ")}>
      {!hideLabel ? <span>{label}</span> : null}
      <div className="site-color-select">
        <button
          aria-expanded={isOpen}
          className="site-color-select-trigger"
          disabled={disabled}
          type="button"
          onBlur={(event) => {
            if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
              setIsOpen(false);
            }
          }}
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="site-color-swatch" style={{ backgroundColor: value }} />
          <span>{selectedLabel}</span>
        </button>
        {isOpen && !disabled && (
          <div className="site-color-menu" role="listbox">
            {SITE_COLOR_OPTIONS.map((option) => (
              <button
                aria-selected={option.value.toLowerCase() === value.toLowerCase()}
                key={option.value}
                role="option"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                <span className="site-color-swatch" style={{ backgroundColor: option.value }} />
                <span>{option.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
