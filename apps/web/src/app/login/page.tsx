'use client';

import { FormEvent, useState } from 'react';
import { api } from '../../lib/api';

interface AuthResult {
  authenticated: boolean;
  confirmationRequired: boolean;
}

export default function LoginPage() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result =
        mode === 'sign-in'
          ? await api<AuthResult>('/v1/auth/sign-in', {
              method: 'POST',
              body: JSON.stringify({ email, password }),
            })
          : await api<AuthResult>('/v1/auth/sign-up', {
              method: 'POST',
              body: JSON.stringify({ email, password, displayName }),
            });
      if (result.confirmationRequired) {
        setNotice('Check your email and confirm the account before logging in.');
        setMode('sign-in');
        return;
      }
      const returnTo = new URLSearchParams(window.location.search).get('returnTo');
      window.location.assign(returnTo?.startsWith('/') ? returnTo : '/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <span className="kicker">Supabase protected account</span>
        <h1>{mode === 'sign-in' ? 'Log in to Zoryqon' : 'Create your Zoryqon account'}</h1>
        <p>Your session is issued by Supabase Auth and stored in secure HTTP-only cookies.</p>
        {mode === 'sign-up' && (
          <label>
            Display name
            <input
              autoComplete="name"
              minLength={2}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
        )}
        <label>
          Email
          <input
            autoComplete="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={8}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <div className="auth-message danger">{error}</div>}
        {notice && <div className="auth-message success">{notice}</div>}
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Log in' : 'Create account'}
        </button>
        <button
          className="auth-switch"
          type="button"
          onClick={() => setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'))}
        >
          {mode === 'sign-in' ? 'Create an account' : 'Use an existing account'}
        </button>
      </form>
    </section>
  );
}
