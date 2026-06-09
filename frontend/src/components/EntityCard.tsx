import type { ReactNode } from "react";

export type EntityCardProps = {
  title: string;
  subtitle?: string;
  meta?: string[];
  status?: ReactNode;
  color?: string | null;
  icon?: ReactNode;
  isInactive?: boolean;
  className?: string;
  onClick?: () => void;
};

export function EntityCard({
  title,
  subtitle,
  meta = [],
  status,
  color,
  icon,
  isInactive = false,
  className,
  onClick,
}: EntityCardProps) {
  const content = (
    <>
      {color && <span className="entity-card-color" style={{ backgroundColor: color }} aria-hidden="true" />}
      {icon && <span className="entity-card-icon">{icon}</span>}
      <span className="entity-card-body">
        <span className="entity-card-title">{title}</span>
        {subtitle && <span className="entity-card-subtitle">{subtitle}</span>}
        {meta.length > 0 && (
          <span className="entity-card-meta">
            {meta.filter(Boolean).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </span>
        )}
      </span>
      {status && <span className="entity-card-status">{status}</span>}
    </>
  );

  const classes = ["entity-card", className, isInactive ? "is-inactive" : ""].filter(Boolean).join(" ");

  if (onClick) {
    return (
      <button className={classes} type="button" onClick={onClick}>
        {content}
      </button>
    );
  }

  return <article className={classes}>{content}</article>;
}
