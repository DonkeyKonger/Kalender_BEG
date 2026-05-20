import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export type EntityDetailDrawerProps = {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
};

export function EntityDetailDrawer({
  isOpen,
  title,
  subtitle,
  children,
  footer,
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

  return (
    <div className="entity-drawer" role="presentation">
      <button className="entity-drawer-overlay" type="button" aria-label="Detailfenster schliessen" onClick={onClose} />
      <aside className="entity-drawer-panel" aria-modal="true" role="dialog" aria-labelledby="entity-drawer-title">
        <header className="entity-drawer-header">
          <div>
            <h2 id="entity-drawer-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="entity-drawer-close" type="button" onClick={onClose} aria-label="Schliessen">
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="entity-drawer-content">{children}</div>
        {footer && <footer className="entity-drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
