import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export type EntityDetailDrawerProps = {
  isOpen: boolean;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  ariaLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
};

export function EntityDetailDrawer({
  isOpen,
  title,
  eyebrow,
  subtitle,
  ariaLabel,
  children,
  footer,
  actions,
  onClose,
}: EntityDetailDrawerProps) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }
  const hasTitleCopy = Boolean(eyebrow || title || subtitle);
  const titleId = title ? "entity-drawer-title" : undefined;

  return (
    <div className="entity-drawer" role="presentation">
      <button className="entity-drawer-overlay" type="button" aria-label="Detailfenster schliessen" onClick={onClose} />
      <aside
        className="entity-drawer-panel"
        aria-label={titleId ? undefined : ariaLabel ?? "Detailfenster"}
        aria-labelledby={titleId}
        aria-modal="true"
        role="dialog"
      >
        <header className={`entity-drawer-header${hasTitleCopy ? "" : " is-action-only"}`}>
          {hasTitleCopy && (
            <div className="entity-drawer-title-copy">
              {eyebrow && <span className="entity-drawer-eyebrow">{eyebrow}</span>}
              {title && <h2 id={titleId}>{title}</h2>}
              {subtitle && <p>{subtitle}</p>}
            </div>
          )}
          <div className="entity-drawer-header-actions">
            {actions}
            <button className="entity-drawer-close" type="button" onClick={onClose} aria-label="Schliessen">
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        </header>
        <div className="entity-drawer-content">{children}</div>
        {footer && <footer className="entity-drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
