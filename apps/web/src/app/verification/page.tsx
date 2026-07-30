'use client';

import type { VerificationStatus } from '@kynorix/contracts';
import { useEffect, useState } from 'react';
import { kynorixApi } from '../../lib/api';

export default function VerificationPage() {
  const [status, setStatus] = useState<VerificationStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void kynorixApi
      .verification()
      .then(setStatus)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Verification status is unavailable.');
      });
  }, []);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const next = await kynorixApi.startVerification({
        requiredLevel: 'basic',
        returnUrl: window.location.href,
        idempotencyKey: crypto.randomUUID(),
      });
      setStatus(next);
      if (next.actionUrl) window.location.assign(next.actionUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification could not be started.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-page">
      <div className="page-heading">
        <span className="kicker">Identity and eligibility</span>
        <h1>Verification</h1>
        <p>
          Identity, age, address, PEP and sanctions checks are completed by the configured
          compliance provider.
        </p>
      </div>
      <section className="form-card">
        <p>Status: {status?.status.replaceAll('_', ' ') ?? 'Loading…'}</p>
        <p>Required level: {status?.level ?? '—'}</p>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : status?.actionUrl ? 'Continue verification' : 'Start verification'}
        </button>
        {error && <div className="ticket-message">{error}</div>}
      </section>
    </div>
  );
}
