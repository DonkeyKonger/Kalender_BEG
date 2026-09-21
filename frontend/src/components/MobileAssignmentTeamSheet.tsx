import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { formatAssignmentColleagues } from "../lib/mobileAssignmentColleagues";
import { useMobileModalStack } from "../lib/useMobileModalStack";

export function MobileAssignmentTeamSheet({ siteName, rangeLabel, colleagues, onClose }: {
  siteName: string;
  rangeLabel: string;
  colleagues: ReturnType<typeof formatAssignmentColleagues>;
  onClose: () => void;
}) {
  const isTopModal = useMobileModalStack(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTopModal) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [isTopModal]);

  return (
    <div
      className="mobile-dialog-backdrop mobile-bottom-sheet-backdrop mobile-team-sheet-backdrop mobile-modal-layer"
      aria-hidden={!isTopModal}
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="mobile-bottom-sheet mobile-assignment-team-sheet"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-assignment-team-title"
        aria-describedby="mobile-assignment-team-context"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key !== "Tab") return;
          const targets = dialogRef.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
          if (!targets?.length) return;
          const first = targets[0], last = targets[targets.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <header className="mobile-bottom-sheet-head">
          <div>
            <h2 id="mobile-assignment-team-title">Mitgeplantes Team · {colleagues.length}</h2>
            <p id="mobile-assignment-team-context">{siteName}<br />{rangeLabel}</p>
          </div>
          <button ref={closeRef} className="mobile-team-sheet-close" type="button" aria-label="Teamliste schließen" onClick={onClose}>
            <X aria-hidden="true" size={22} />
          </button>
        </header>
        <p className="mobile-team-sheet-hint">Kollegen und ihre gemeinsamen Einsatztage</p>
        <ul className="mobile-team-sheet-list mobile-modal-scroll-region" tabIndex={0} aria-label="Kollegen und Einsatztage">
          {colleagues.map(colleague => (
            <li key={colleague.personId}><span>{colleague.name}</span><span>{colleague.period}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
