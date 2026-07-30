'use client';

import { useCallback, useEffect, useState } from 'react';
import { zoryqonApi } from '../../../lib/api';

type Session = Awaited<ReturnType<typeof zoryqonApi.sessions>>[number];

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setSessions(await zoryqonApi.sessions());
  }, []);
  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Sessions could not be loaded.'),
    );
  }, [load]);
  async function revoke(sessionRef: string) {
    try {
      await zoryqonApi.revokeSession(sessionRef);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session could not be revoked.');
    }
  }
  return (
    <div className="form-page">
      <div className="page-heading">
        <span className="kicker">Device access</span>
        <h1>Active sessions</h1>
        <p>Review browser sessions and revoke access you do not recognize.</p>
      </div>
      <section className="form-card">
        {sessions.map((session) => (
          <div className="ticket-message" key={session.sessionRef}>
            <strong>{session.userAgent ?? 'Unknown client'}</strong>
            <span>
              {session.ip ?? 'Unknown address'} · Last active{' '}
              {new Date(session.lastSeenAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
            </span>
            <button className="secondary-button" onClick={() => void revoke(session.sessionRef)}>
              Revoke
            </button>
          </div>
        ))}
        {!sessions.length && !error && <p>No active web sessions were found.</p>}
        {error && <div className="ticket-message">{error}</div>}
      </section>
    </div>
  );
}
