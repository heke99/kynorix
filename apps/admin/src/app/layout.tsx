import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kynorix Operations',
  description: 'Protected Kynorix market, resolution, risk and finance operations.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
