import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { api } from "../lib/api";
import type { ProjectFolder } from "../types/site";
import "./ProjectFolderAccessMenu.css";

export type FolderAccessMenuTarget = {
  folder: ProjectFolder;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
};

export function ProjectFolderAccessMenu({ target, onUpdated, onClose }: {
  target: FolderAccessMenuTarget;
  onUpdated: (folder: ProjectFolder) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { folder } = target;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`;
  }, [target, error]);

  useEffect(() => {
    itemRef.current?.focus();
    function close(restoreFocus = false) {
      if (pendingRef.current) return;
      if (restoreFocus) target.trigger.focus();
      onClose();
    }
    function pointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        close(true);
      }
    }
    function reposition() { close(true); }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [target, onClose]);

  async function toggleVisibility() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateProjectFolderVisibility(folder.site_id, folder.folder_key, !folder.visible_for_monteurs);
      onUpdated({ ...updated, file_count: folder.file_count });
      target.trigger.focus();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Freigabe konnte nicht gespeichert werden.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return createPortal(
    <div ref={menuRef} className="project-folder-access-menu" style={{ left: target.x, top: target.y }}
      onContextMenu={(event) => event.preventDefault()}>
      <div className="project-folder-access-menu-title">{folder.name}</div>
      <div role="menu" aria-label={`Ordnerfreigabe: ${folder.name}`} aria-busy={pending}>
        <button ref={itemRef} type="button" role="menuitemcheckbox" aria-checked={Boolean(folder.visible_for_monteurs)}
          aria-disabled={pending} onClick={() => void toggleVisibility()}>
          <span className="project-folder-access-check">{folder.visible_for_monteurs ? <Check size={15} aria-hidden="true" /> : null}</span>
          {pending ? "Wird gespeichert …" : "Für Monteure sichtbar"}
        </button>
      </div>
      <p>Gilt nur für diese Baustelle.</p>
      {error ? <p className="project-folder-access-error" role="alert">{error}</p> : null}
    </div>, document.body,
  );
}
