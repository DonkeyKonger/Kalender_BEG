import { ArrowLeft } from "lucide-react";


export function MobileBackButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="mobile-back-icon-button"
      type="button"
      onClick={onClick}
    >
      <ArrowLeft aria-hidden="true" size={25} />
    </button>
  );
}
