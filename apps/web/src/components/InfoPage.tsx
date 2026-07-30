export function InfoPage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="info-page">
      <div className="page-heading">
        <span className="kicker">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <section className="rules-card">{children}</section>
    </div>
  );
}
