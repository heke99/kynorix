import type { Metadata } from 'next';
import Link from 'next/link';
import { AppHeader } from '../components/AppHeader';
import { BrandMark } from '../components/BrandMark';
import { DevelopmentBrowserCleanup } from '../components/DevelopmentBrowserCleanup';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zoryqon — Event Exchange',
  description: 'Trade transparent event markets with published rules and verifiable outcomes.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <DevelopmentBrowserCleanup />
        <AppHeader />
        <main>{children}</main>
        <footer>
          <div className="brand footer-brand">
            <BrandMark /> <span>Zoryqon</span>
          </div>
          <nav aria-label="Legal links">
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/risk-disclosure">Risk disclosure</Link>
            <Link href="/support">Support</Link>
          </nav>
          <p>Trading involves risk. Market availability depends on eligibility and jurisdiction.</p>
        </footer>
      </body>
    </html>
  );
}
