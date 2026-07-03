import { useState } from "react";

import { SITE_COLOR_OPTIONS } from "../lib/siteColors";

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
  const selectedLabel = selectedOption?.label ?? label;

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
                aria-label={`${option.label} (${option.name})`}
                aria-selected={option.value.toLowerCase() === value.toLowerCase()}
                key={option.value}
                role="option"
                title={option.name}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                <span className="site-color-swatch" style={{ backgroundColor: option.value }} />
                <span className="site-color-option-text">
                  <span>{option.label}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
