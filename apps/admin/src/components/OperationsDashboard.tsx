'use client';

import type { Market } from '@kynorix/contracts';
import { useCallback, useEffect, useState } from 'react';
import { operationsApi } from '../lib/api';

type Capabilities = Awaited<ReturnType<typeof operationsApi.capabilities>>;

export function OperationsDashboard() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [selected, setSelected] = useState<Market>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposalRef, setProposalRef] = useState('');

  const refresh = useCallback(async () => {
    const [nextMarkets, nextCapabilities] = await Promise.all([
      operationsApi.markets(),
      operationsApi.capabilities(),
    ]);
    setMarkets(nextMarkets);
    setCapabilities(nextCapabilities);
    setSelected((current) =>
      current ? nextMarkets.find((market) => market.marketRef === current.marketRef) : undefined,
    );
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Operationsdata kunde inte hämtas'),
    );
  }, [refresh]);

  async function closeMarket() {
    if (!selected) return;
    setBusy(true);
    try {
      const market = await operationsApi.closeForResolution(selected.marketRef, 'officer-livia');
      setSelected(market);
      setNotice('Handeln är stoppad och marknaden väntar på resolution.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Marknaden kunde inte stängas');
    } finally {
      setBusy(false);
    }
  }

  async function propose(outcomeRef: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const contentHash = await sha256(
        `${selected.marketRef}:${outcomeRef}:${selected.resolutionSource}`,
      );
      const proposal = await operationsApi.proposeResolution(selected.marketRef, 'officer-livia', {
        outcomeRef,
        reason:
          'Den officiella primärkällan har kontrollerats mot marknadens låsta regelversion och stöder valt utfall.',
        evidence: [
          {
            source: selected.resolutionSource,
            capturedAt: new Date().toISOString(),
            contentHash,
            notes:
              'Sandboxbevis skapat av resolution officer. I produktion lagras även källmaterialet i immutable object storage.',
          },
        ],
      });
      setProposalRef(proposal.proposalRef);
      setNotice('Förslag registrerat. En annan officer måste nu godkänna.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Resolutionen kunde inte föreslås');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!proposalRef) return;
    setBusy(true);
    try {
      const result = await operationsApi.approveResolution(proposalRef, 'officer-noah');
      setSelected(result.market);
      setNotice('Oberoende godkännande klart. Settlement genomfört exakt en gång.');
      setProposalRef('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Godkännandet misslyckades');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-shell">
      <aside className="sidebar">
        <div className="ops-brand">
          <span>K</span>
          <b>kynorix</b>
          <small>operations</small>
        </div>
        <nav>
          <button className="active">
            <span>◇</span> Översikt
          </button>
          <button>
            <span>⌁</span> Marknader
          </button>
          <button>
            <span>⇄</span> Order & fills
          </button>
          <button>
            <span>◎</span> Resolution
          </button>
          <button>
            <span>◫</span> Ledger
          </button>
          <button>
            <span>△</span> Riskfall
          </button>
          <button>
            <span>◉</span> Compliance
          </button>
          <button>
            <span>⌘</span> Incidenter
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className="health-dot" /> Sandbox · operativ
          <small>{capabilities?.release ?? 'ansluter…'}</small>
        </div>
      </aside>

      <main className="ops-main">
        <header>
          <div>
            <span className="kicker">Kontrollrum</span>
            <h1>Operationsöversikt</h1>
          </div>
          <div className="operator">
            <span>LO</span>
            <div>
              <b>Livia O.</b>
              <small>resolution_officer</small>
            </div>
          </div>
        </header>

        {error && (
          <div className="alert danger">
            <b>Åtgärd krävs</b>
            {error}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}
        {notice && (
          <div className="alert success">
            <b>Klart</b>
            {notice}
            <button onClick={() => setNotice('')}>×</button>
          </div>
        )}

        <section className="metric-grid">
          <article>
            <span>Aktiva marknader</span>
            <strong>{markets.filter((market) => market.status === 'open').length}</strong>
            <small>virtuella</small>
          </article>
          <article>
            <span>Resolution väntar</span>
            <strong>
              {markets.filter((market) => market.status === 'resolution_pending').length}
            </strong>
            <small>fyrögonskrav</small>
          </article>
          <article>
            <span>Ledgeravvikelse</span>
            <strong className="good">0</strong>
            <small>debet = kredit</small>
          </article>
          <article>
            <span>Real-money</span>
            <strong className="blocked">Spärrad</strong>
            <small>server policy</small>
          </article>
        </section>

        <div className="ops-grid">
          <section className="ops-card market-table-card">
            <div className="card-title">
              <div>
                <span className="kicker">Market engine</span>
                <h2>Marknader</h2>
              </div>
              <button onClick={() => void refresh()}>Uppdatera</button>
            </div>
            <div className="market-table">
              <div className="market-row market-head">
                <span>Marknad</span>
                <span>Status</span>
                <span>Produkt</span>
                <span>Stänger</span>
                <span />
              </div>
              {markets.map((market) => (
                <button
                  className={
                    selected?.marketRef === market.marketRef ? 'market-row selected' : 'market-row'
                  }
                  key={market.marketRef}
                  onClick={() => {
                    setSelected(market);
                    setProposalRef('');
                  }}
                >
                  <span>
                    <b>{market.title}</b>
                    <small>{market.marketRef}</small>
                  </span>
                  <span>
                    <i className={`status status-${market.status}`} />
                    {market.status}
                  </span>
                  <span>{market.productType}</span>
                  <span>{new Date(market.closesAt).toLocaleDateString('sv-SE')}</span>
                  <span>›</span>
                </button>
              ))}
            </div>
          </section>

          <section className="ops-card policy-card">
            <div className="card-title">
              <div>
                <span className="kicker">Policy enforcement</span>
                <h2>Produktgrindar</h2>
              </div>
              <span className="lock">Låst</span>
            </div>
            <p>Klienter kan inte kringgå dessa beslut.</p>
            <div className="policy-list">
              {capabilities?.enabled.map((value) => (
                <div key={value}>
                  <span className="policy-icon allowed">✓</span>
                  <span>{label(value)}</span>
                  <b>Tillåten</b>
                </div>
              ))}
              {capabilities?.denied.slice(0, 6).map((value) => (
                <div key={value}>
                  <span className="policy-icon denied">×</span>
                  <span>{label(value)}</span>
                  <b>Spärrad</b>
                </div>
              ))}
            </div>
          </section>
        </div>

        {selected && (
          <section className="ops-card resolution-panel">
            <div className="card-title">
              <div>
                <span className="kicker">Resolution workflow</span>
                <h2>{selected.title}</h2>
              </div>
              <span className={`large-status status-${selected.status}`}>{selected.status}</span>
            </div>
            <div className="resolution-steps">
              <div className={selected.status !== 'open' ? 'done' : 'current'}>
                <span>1</span>
                <b>Stäng handel</b>
                <small>stoppa och avbryt öppna order</small>
              </div>
              <div
                className={
                  proposalRef ? 'done' : selected.status === 'resolution_pending' ? 'current' : ''
                }
              >
                <span>2</span>
                <b>Föreslå utfall</b>
                <small>officer + beviskedja</small>
              </div>
              <div
                className={selected.status === 'settled' ? 'done' : proposalRef ? 'current' : ''}
              >
                <span>3</span>
                <b>Oberoende godkännande</b>
                <small>annan officer</small>
              </div>
              <div className={selected.status === 'settled' ? 'done' : ''}>
                <span>4</span>
                <b>Settlement</b>
                <small>idempotent ledgerpost</small>
              </div>
            </div>
            <div className="resolution-actions">
              {selected.status === 'open' && (
                <button className="primary" disabled={busy} onClick={closeMarket}>
                  Stäng för resolution
                </button>
              )}
              {selected.status === 'resolution_pending' &&
                !proposalRef &&
                selected.outcomes.map((outcome) => (
                  <button
                    className={outcome.label === 'JA' ? 'yes' : 'no'}
                    disabled={busy}
                    key={outcome.outcomeRef}
                    onClick={() => void propose(outcome.outcomeRef)}
                  >
                    Föreslå {outcome.label}
                  </button>
                ))}
              {proposalRef && (
                <button className="primary" disabled={busy} onClick={approve}>
                  Godkänn som officer Noah
                </button>
              )}
              {selected.status === 'settled' && (
                <span className="settled-proof">
                  ✓ Marknaden är slutreglerad och journalerna har balanserats.
                </span>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
