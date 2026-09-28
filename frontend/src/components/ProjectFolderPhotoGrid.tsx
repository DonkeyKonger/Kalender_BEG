import { Download, ExternalLink, FileText, Folder, X } from "lucide-react";
import { getProjectDocumentKind } from "../lib/projectFiles";
import type { ProjectDocumentSort, ProjectDocumentSortKey } from "../lib/projectDocumentSort";
import type { ProjectFolderDocumentItem } from "../types/site";
import { MobileFolderPhotoTile } from "./MobileFolderPhotoTile";
import { ProjectDocumentFilename } from "./ProjectDocumentFilename";
import "./ProjectFolderPhotoGrid.css";

export function ProjectFolderPhotoGrid({ siteId, folderKey, items, sort, onSort, canEdit,
  openingItemId, downloadingItemId, deletingItemId, folderNavigationLoading,
  onOpen, onOpenFolder, onDownload, onDelete, onRename,
}: {
  siteId: number;
  folderKey: string;
  items: ProjectFolderDocumentItem[];
  sort: ProjectDocumentSort;
  onSort: (key: ProjectDocumentSortKey) => void;
  canEdit: boolean;
  openingItemId: string | null;
  downloadingItemId: string | null;
  deletingItemId: string | null;
  folderNavigationLoading: boolean;
  onOpen: (item: ProjectFolderDocumentItem) => Promise<void>;
  onOpenFolder: (item: ProjectFolderDocumentItem) => Promise<void>;
  onDownload: (item: ProjectFolderDocumentItem) => Promise<void>;
  onDelete: (item: ProjectFolderDocumentItem) => Promise<void>;
  onRename: (item: ProjectFolderDocumentItem, name: string) => Promise<void>;
}) {
  const sortOptions: [ProjectDocumentSortKey, string][] = [["name", "Dateiname"], ["type", "Typ"], ["uploaded", "Hochgeladen"]];
  return <>
    <div className="project-photo-sort" role="group" aria-label="Fotos sortieren">
      {sortOptions.map(([key, label]) => <button key={key} type="button"
        className={`project-document-sort-trigger${sort.key === key ? " is-active" : ""}`}
        aria-label={`${label} ${sort.key === key ? sort.direction === "asc" ? "absteigend" : "aufsteigend" : key === "uploaded" ? "absteigend" : "aufsteigend"} sortieren`}
        onClick={() => onSort(key)}>
        {label}{sort.key === key ? <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span> : null}
      </button>)}
    </div>
    <div className="project-photo-grid">
      {items.map((item) => {
        if (item.is_folder) return <button key={item.id} type="button" className="project-photo-subfolder"
          disabled={folderNavigationLoading} onClick={() => void onOpenFolder(item)}>
          <Folder size={18} aria-hidden="true" /><strong>{item.name}</strong>
        </button>;
        const isPhoto = getProjectDocumentKind(item) === "image";
        return <article key={item.id} className={`project-photo-card${isPhoto ? "" : " is-document"}`}>
          {isPhoto ? <MobileFolderPhotoTile siteId={siteId} folderKey={folderKey} item={item}
            className="project-photo-preview" isOpening={openingItemId === item.id} onOpen={() => void onOpen(item)} />
            : <button type="button" className="project-photo-document-icon" onClick={() => void onOpen(item)}
                disabled={openingItemId === item.id} aria-label={`Datei öffnen: ${item.name}`}><FileText size={24} aria-hidden="true" /></button>}
          <div className="project-photo-caption">
            <div className="project-document-name-cell">
              <ProjectDocumentFilename name={item.name} editable={canEdit && Boolean(item.id) && deletingItemId !== item.id}
                onRename={(name) => onRename(item, name)} />
            </div>
            <div className="project-photo-actions">
              <button type="button" aria-label={`Öffnen: ${item.name}`} title="Öffnen"
                disabled={openingItemId === item.id} onClick={() => void onOpen(item)}><ExternalLink size={15} aria-hidden="true" /></button>
              <button type="button" aria-label={`Herunterladen: ${item.name}`} title="Herunterladen"
                disabled={downloadingItemId === item.id} onClick={() => void onDownload(item)}><Download size={15} aria-hidden="true" /></button>
              {canEdit && item.id ? <button type="button" aria-label={`Datei „${item.name}“ löschen`} title="Löschen"
                disabled={deletingItemId !== null} onClick={() => void onDelete(item)}><X size={15} aria-hidden="true" /></button> : null}
            </div>
          </div>
        </article>;
      })}
    </div>
  </>;
}
