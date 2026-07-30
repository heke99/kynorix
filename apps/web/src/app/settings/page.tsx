'use client';
import type { AuthenticatedUser } from '@zoryqon/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { zoryqonApi } from '../../lib/api';
export default function SettingsPage() {
  const [user, setUser] = useState<AuthenticatedUser>();
  useEffect(() => {
    void zoryqonApi
      .me()
      .then(setUser)
      .catch(() => window.location.assign(zoryqonApi.loginUrl('/settings')));
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
        <button onClick={() => void zoryqonApi.logout().then(() => window.location.assign('/'))}>
          Log out
        </button>
      </div>
    </div>
  );
}
