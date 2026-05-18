type PlaceholderPageProps = {
  eyebrow: string;
  title: string;
};

export function PlaceholderPage({ eyebrow, title }: PlaceholderPageProps) {
  return (
    <section className="page-stack">
      <div className="page-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="empty-panel">
        <p>Dieser Bereich wird in den naechsten Schritten mit echten Daten gefuellt.</p>
      </div>
    </section>
  );
}
