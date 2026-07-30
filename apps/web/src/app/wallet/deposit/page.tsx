'use client';

import { useState } from 'react';
import { zoryqonApi } from '../../../lib/api';

export default function DepositPage() {
  const [asset, setAsset] = useState('USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<
    'bank_transfer' | 'open_banking' | 'card' | 'stablecoin' | 'crypto'
  >('bank_transfer');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setResult('');
    try {
      const response = await zoryqonApi.createDeposit({
        asset,
        method,
        amountAtoms: amount,
        idempotencyKey: crypto.randomUUID(),
      });
      setResult(`Deposit initiated. ${JSON.stringify(response)}`);
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : 'Deposit could not be created.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-page">
      <div className="page-heading">
        <span className="kicker">Add funds</span>
        <h1>Deposit</h1>
        <p>
          Funds become available only after provider confirmation, compliance checks and ledger
          credit.
        </p>
      </div>
      <section className="form-card">
        <label>
          Method
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as typeof method)}
          >
            <option value="bank_transfer">Bank transfer</option>
            <option value="open_banking">Open banking</option>
            <option value="card">Card</option>
            <option value="stablecoin">Stablecoin</option>
            <option value="crypto">Crypto</option>
          </select>
        </label>
        <label>
          Asset
          <input value={asset} onChange={(event) => setAsset(event.target.value.toUpperCase())} />
        </label>
        <label>
          Amount in atomic units
          <input
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button className="primary-button" disabled={busy || !amount} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Continue with provider'}
        </button>
        {result && <div className="ticket-message">{result}</div>}
      </section>
    </div>
  );
}
