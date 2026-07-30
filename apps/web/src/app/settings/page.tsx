'use client';
import type { AuthenticatedUser } from '@kynorix/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { kynorixApi } from '../../lib/api';
export default function SettingsPage() {
  const [user, setUser] = useState<AuthenticatedUser>();
  useEffect(() => {
    void kynorixApi
      .me()
      .then(setUser)
      .catch(() => window.location.assign(kynorixApi.loginUrl('/settings')));
  }, []);
  return (
    <div className="portfolio-page">
      <div className="page-heading">
        <span className="kicker">Account</span>
        <h1>Settings</h1>
        <p>
          {user?.displayName} · {user?.email}
        </p>
      </div>
      <div className="settings-grid">
        <Link href="/settings/security">Security and MFA</Link>
        <Link href="/settings/sessions">Active sessions</Link>
        <Link href="/settings/notifications">Notifications</Link>
        <button onClick={() => void kynorixApi.logout().then(() => window.location.assign('/'))}>
          Log out
        </button>
      </div>
    </div>
  );
}
