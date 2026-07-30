import type { Metadata } from 'next';
import { AppHeader } from '../components/AppHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kynorix — Event Exchange',
  description: 'Virtuella, transparenta eventmarknader för bättre prognoser.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv">
      <body>
        <AppHeader />
        <main>{children}</main>
        <footer>
          <div className="brand footer-brand">
            <span className="brand-mark">K</span> kynorix
          </div>
          <p>Sandbox för teknisk validering. Inga riktiga pengar, insättningar eller uttag.</p>
        </footer>
      </body>
    </html>
  );
}
