import { useEffect, useMemo, useState } from "react";

import { useMobileModalStack } from "../lib/useMobileModalStack";

const MAX_PHOTO_CAPTION_LENGTH = 500;

function normalizeCaption(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

export function MobilePhotoCaptionViewer({
  alt,
  canEdit,
  caption,
  dateLabel,
  filename,
  imageUrl,
  onClose,
  onSave,
}: {
  alt: string;
  canEdit: boolean;
  caption: string | null;
  dateLabel: string;
  filename: string;
  imageUrl: string;
  onClose: () => void;
  onSave: (caption: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(caption ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isTopModal = useMobileModalStack(true);
  const normalizedDraft = useMemo(() => normalizeCaption(draft), [draft]);
  const isDirty = normalizedDraft !== normalizeCaption(caption ?? "");

  useEffect(() => {
    setDraft(caption ?? "");
    setSaveError(null);
  }, [caption]);

  function closeViewer(): void {
    if (isSaving) {
      return;
    }
    if (isDirty && !window.confirm("Ungespeicherte Beschriftung verwerfen?")) {
      return;
    }
    onClose();
  }

  async function saveCaption(): Promise<void> {
    if (!canEdit || !isDirty || isSaving) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(normalizedDraft);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Beschriftung konnte nicht gespeichert werden.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      aria-hidden={!isTopModal}
      className="mobile-photo-preview-backdrop mobile-modal-layer"
      data-mobile-modal-active={isTopModal}
      inert={!isTopModal}
      role="presentation"
      onClick={closeViewer}
    >
      <div
        aria-label="Fotoansicht"
        aria-modal="true"
        className="mobile-photo-preview mobile-modal-scroll-region"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <img alt={alt} src={imageUrl} />
        <section className="mobile-photo-caption-section">
          <label htmlFor="mobile-photo-caption">Beschriftung</label>
          <textarea
            id="mobile-photo-caption"
            maxLength={MAX_PHOTO_CAPTION_LENGTH}
            placeholder="Beschriftung hinzufügen …"
            readOnly={!canEdit}
            rows={3}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaveError(null);
            }}
          />
          {!canEdit ? <small>Dieses Dokument ist gesperrt. Die Beschriftung kann nur gelesen werden.</small> : null}
        </section>
        <div className="mobile-photo-preview-meta">
          <time>{dateLabel}</time>
          <small title={filename}>{filename}</small>
        </div>
        {saveError ? <p className="form-error mobile-photo-caption-feedback" role="alert">{saveError}</p> : null}
        <div className="mobile-photo-preview-actions">
          {canEdit ? (
            <button className="primary-action" type="button" disabled={!isDirty || isSaving} onClick={() => void saveCaption()}>
              {isSaving ? "Speichert..." : "Speichern"}
            </button>
          ) : null}
          <button className="secondary-action" type="button" disabled={isSaving} onClick={closeViewer}>Schließen</button>
        </div>
      </div>
    </div>
  );
}
