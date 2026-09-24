import { useEffect, useRef, useState } from "react";
import { Images } from "lucide-react";
import { api } from "../lib/api";
import type { ProjectFolderDocumentItem } from "../types/site";

export function MobileFolderPhotoTile({ siteId, folderKey, item, isOpening, onOpen }: {
  siteId: number;
  folderKey: string;
  item: ProjectFolderDocumentItem;
  isOpening: boolean;
  onOpen: () => void;
}) {
  const element = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let started = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    async function load() {
      if (started) return;
      started = true;
      try {
        const blob = await api.projectFolderDocumentThumbnail(siteId, folderKey, item.id, item.last_modified_date_time);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    }
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer?.disconnect();
        void load();
      }
    }, { rootMargin: "200px" });
    if (observer && element.current) observer.observe(element.current);
    else void load();
    return () => {
      active = false;
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [siteId, folderKey, item.id, item.last_modified_date_time]);

  return <button ref={element} type="button" className="mobile-folder-photo-tile"
    onClick={onOpen} disabled={isOpening} aria-label={`Foto öffnen: ${item.name}`} title={item.name}>
    {url && !failed ? <img src={url} alt="" decoding="async" onError={() => setFailed(true)} /> :
      <span className="mobile-folder-photo-placeholder"><Images size={26} aria-hidden="true" />
        <small>{failed ? "Vorschau nicht verfügbar" : "Vorschau lädt…"}</small></span>}
    {isOpening && <span className="mobile-folder-photo-loading">Öffnen…</span>}
  </button>;
}
