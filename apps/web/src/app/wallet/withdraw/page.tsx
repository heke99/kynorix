'use client';

import type { CreateWithdrawal, Withdrawal } from '@zoryqon/contracts';
import { useState } from 'react';
import { zoryqonApi } from '../../../lib/api';

export default function WithdrawPage() {
  const [input, setInput] = useState<CreateWithdrawal>({
    method: 'bank_transfer',
    asset: 'USD',
    amountAtoms: '',
    destinationRef: '',
    idempotencyKey: '',
  });
  const [created, setCreated] = useState<Withdrawal>();
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setResult('');
    const payload = { ...input, idempotencyKey: crypto.randomUUID() };
    try {
      setInput(payload);
      setCreated(await zoryqonApi.createWithdrawal(payload));
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : 'Withdrawal could not be created.');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!created) return;
    setBusy(true);
    try {
      setCreated(
        await zoryqonApi.confirmWithdrawal(created.withdrawalRef, {
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setResult('Withdrawal submitted to the configured provider.');
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : 'Withdrawal confirmation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-page">
      <div className="page-heading">
        <span className="kicker">Transfer funds</span>
        <h1>Withdraw</h1>
        <p>
          New destinations, risk reviews and higher-value withdrawals may require additional
          approval.
        </p>
      </div>
      <section className="form-card">
        <label>
          Method
          <select
            value={input.method}
            onChange={(event) =>
              setInput({ ...input, method: event.target.value as CreateWithdrawal['method'] })
            }
          >
            <option value="bank_transfer">Bank transfer</option>
            <option value="stablecoin">Stablecoin</option>
            <option value="crypto">Crypto</option>
          </select>
        </label>
        <label>
          Asset
          <input
            value={input.asset}
            onChange={(event) => setInput({ ...input, asset: event.target.value.toUpperCase() })}
          />
        </label>
        <label>
          Amount in atomic units
          <input
            inputMode="numeric"
            value={input.amountAtoms}
            onChange={(event) =>
              setInput({ ...input, amountAtoms: event.target.value.replace(/\D/g, '') })
            }
          />
        </label>
        <label>
          Verified destination reference
          <input
            value={input.destinationRef}
            onChange={(event) => setInput({ ...input, destinationRef: event.target.value })}
          />
        </label>
        {!created ? (
          <button
            className="primary-button"
            disabled={busy || !input.amountAtoms || !input.destinationRef}
            onClick={() => void create()}
          >
            {busy ? 'Checking…' : 'Review withdrawal'}
          </button>
        ) : (
          <button className="primary-button" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Confirming…' : 'Confirm with MFA or passkey'}
          </button>
        )}
        {created && (
          <div className="ticket-message">
            Status: {created.status.replaceAll('_', ' ')} · {created.withdrawalRef}
          </div>
        )}
        {result && <div className="ticket-message">{result}</div>}
      </section>
    </div>
  );
}
