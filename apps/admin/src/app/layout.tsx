import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zoryqon Operations',
  description: 'Protected Zoryqon market, resolution, risk and finance operations.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
