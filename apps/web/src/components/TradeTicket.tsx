'use client';

import type { FeeQuote, Market, OrderSide, Outcome, TimeInForce } from '@zoryqon/contracts';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatAtoms, zoryqonApi } from '../lib/api';

export function TradeTicket({
  market,
  selectedOutcome,
  onOutcomeChange,
  suggestedPrice,
  onPlaced,
}: {
  market: Market;
  selectedOutcome: Outcome;
  onOutcomeChange: (outcome: Outcome) => void;
  suggestedPrice: string | undefined;
  onPlaced: () => void;
}) {
  const [side, setSide] = useState<OrderSide>('buy');
  const [price, setPrice] = useState(suggestedPrice ?? '50');
  const [quantity, setQuantity] = useState('10');
  const [timeInForce, setTimeInForce] = useState<TimeInForce>('GTC');
  const [postOnly, setPostOnly] = useState(false);
  const [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<FeeQuote>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const orderValue = useMemo(
    () => (BigInt(price || '0') * BigInt(quantity || '0')).toString(),
    [price, quantity],
  );

  function resetQuote() {
    setQuote(undefined);
    setMessage('');
  }

  async function review() {
    setBusy(true);
    setMessage('');
    try {
      setQuote(
        await zoryqonApi.quoteOrder({
          marketRef: market.marketRef,
          outcomeRef: selectedOutcome.outcomeRef,
          side,
          priceAtoms: price,
          quantity,
          timeInForce,
          postOnly,
          maximumSlippageBasisPoints: slippage,
        }),
      );
    } catch (cause) {
      handleError(cause, market.marketRef, setMessage);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true);
    setMessage('');
    try {
      const order = await zoryqonApi.placeOrder({
        marketRef: market.marketRef,
        outcomeRef: selectedOutcome.outcomeRef,
        side,
        type: 'limit',
        priceAtoms: price,
        quantity,
        timeInForce,
        postOnly,
        maximumSlippageBasisPoints: slippage,
        quoteRef: quote.quoteRef,
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(`Order ${order.status.replaceAll('_', ' ')} · ${order.orderRef}`);
      setQuote(undefined);
      onPlaced();
    } catch (cause) {
      handleError(cause, market.marketRef, setMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="trade-ticket">
      <div className="ticket-tabs">
        <button
          className={side === 'buy' ? 'active' : ''}
          onClick={() => {
            setSide('buy');
            resetQuote();
          }}
        >
          Buy
        </button>
        <button
          className={side === 'sell' ? 'active' : ''}
          onClick={() => {
            setSide('sell');
            resetQuote();
          }}
        >
          Sell
        </button>
      </div>
      <div className="outcome-selector">
        {market.outcomes.map((outcome) => (
          <button
            key={outcome.outcomeRef}
            className={outcome.outcomeRef === selectedOutcome.outcomeRef ? 'active' : ''}
            onClick={() => {
              onOutcomeChange(outcome);
              resetQuote();
            }}
          >
            {outcome.label}
          </button>
        ))}
      </div>
      <label>
        Limit price
        <div className="input-suffix">
          <input
            inputMode="numeric"
            min="1"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value.replace(/\D/g, ''));
              resetQuote();
            }}
          />
          <span>atoms</span>
        </div>
      </label>
      <label>
        Quantity
        <input
          inputMode="numeric"
          min="1"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value.replace(/\D/g, ''));
            resetQuote();
          }}
        />
      </label>
      <div className="ticket-options">
        <label>
          Time in force
          <select
            value={timeInForce}
            onChange={(event) => {
              setTimeInForce(event.target.value as TimeInForce);
              resetQuote();
            }}
          >
            <option value="GTC">Good until cancelled</option>
            <option value="IOC">Immediate or cancel</option>
            <option value="FOK">Fill or kill</option>
          </select>
        </label>
        <label className="check-option">
          <input
            type="checkbox"
            checked={postOnly}
            onChange={(event) => {
              setPostOnly(event.target.checked);
              resetQuote();
            }}
          />
          Post only
        </label>
        <label>
          Maximum slippage
          <select
            value={slippage}
            onChange={(event) => {
              setSlippage(Number(event.target.value));
              resetQuote();
            }}
          >
            <option value="25">0.25%</option>
            <option value="50">0.50%</option>
            <option value="100">1.00%</option>
            <option value="200">2.00%</option>
          </select>
        </label>
      </div>
      <div className="ticket-summary">
        <span>Estimated order value</span>
        <strong>{formatAtoms(orderValue, market.collateralAsset, market.assetDecimals)}</strong>
        <span>Authoritative fee</span>
        <strong>
          {quote
            ? formatAtoms(quote.feeAtoms, quote.asset, market.assetDecimals)
            : 'Review required'}
        </strong>
        <span>Total debit</span>
        <strong>
          {quote ? formatAtoms(quote.totalDebitAtoms, quote.asset, market.assetDecimals) : '—'}
        </strong>
        <span>Possible payout</span>
        <strong>
          {quote ? formatAtoms(quote.potentialPayoutAtoms, quote.asset, market.assetDecimals) : '—'}
        </strong>
        <span>Profit if correct</span>
        <strong>
          {quote ? formatAtoms(quote.potentialProfitAtoms, quote.asset, market.assetDecimals) : '—'}
        </strong>
      </div>
      {!quote ? (
        <button
          className="primary-button"
          disabled={busy || !price || !quantity}
          onClick={() => void review()}
        >
          {busy ? 'Calculating…' : 'Review order'}
        </button>
      ) : (
        <div className="confirm-actions">
          <button className="secondary-button" disabled={busy} onClick={resetQuote}>
            Edit
          </button>
          <button className="primary-button" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Submitting…' : `Confirm ${side}`}
          </button>
        </div>
      )}
      {message && (
        <div className="ticket-message">
          {message}
          {message.includes('balance') && <Link href="/wallet/deposit">Deposit funds</Link>}
          {message.includes('verification') && <Link href="/verification">Verify identity</Link>}
        </div>
      )}
    </aside>
  );
}

function handleError(cause: unknown, marketRef: string, setMessage: (value: string) => void) {
  const error = cause as Error & { status?: number };
  if (error.status === 401) {
    window.location.assign(zoryqonApi.loginUrl(`/markets/${marketRef}`));
    return;
  }
  setMessage(error.message || 'The order could not be processed.');
}
