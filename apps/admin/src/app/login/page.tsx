'use client';

import { FormEvent, useState } from 'react';
import { adminApi } from '../../lib/api';
import { BrandMark } from '../../components/BrandMark';

export default function OperationsLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi('/v1/auth/sign-in', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      window.location.assign('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ops-login-page">
      <form className="ops-login-card" onSubmit={submit}>
        <div className="ops-login-brand"><BrandMark /><b>Zoryqon Operations</b></div>
        <h1>Protected access</h1>
        <p>Use the Supabase account that has an operations role in Zoryqon.</p>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <div className="ops-login-error">{error}</div>}
        <button disabled={busy} type="submit">{busy ? 'Please wait…' : 'Log in'}</button>
      </form>
    </main>
  );
}
