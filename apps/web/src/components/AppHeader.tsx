import Link from 'next/link';

export function AppHeader() {
  return (
    <header className="app-header">
      <Link className="brand" href="/" aria-label="Kynorix startsida">
        <span className="brand-mark" aria-hidden="true">
          K
        </span>
        <span>kynorix</span>
      </Link>
      <nav aria-label="Huvudnavigering">
        <Link href="/">Marknader</Link>
        <Link href="/portfolio">Portfölj</Link>
        <a href="http://localhost:3001">Operations</a>
      </nav>
      <div className="header-actions">
        <span className="sandbox-pill">
          <span className="status-dot" /> Virtuell sandbox
        </span>
        <span className="avatar" title="Demoanvändare Alex">
          A
        </span>
      </div>
    </header>
  );
}
