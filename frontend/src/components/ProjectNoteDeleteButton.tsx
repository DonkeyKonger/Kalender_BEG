import { Trash2 } from "lucide-react";

export function ProjectNoteDeleteButton({ title, disabled, onDelete }: {
  title: string;
  disabled?: boolean;
  onDelete: () => void;
}) {
  return <button type="button" className="site-project-note-delete" disabled={disabled}
    aria-label={`${title} dauerhaft löschen`} title="Notiz dauerhaft löschen"
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => {
      if (window.confirm(`„${title}“ dauerhaft löschen? Die Notiz kann nicht wiederhergestellt werden.`)) onDelete();
    }}>
    <Trash2 size={16} aria-hidden="true" />
  </button>;
}
