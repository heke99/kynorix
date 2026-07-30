'use client';

import type { AuthenticatedUser, CreateMarket, Market } from '@zoryqon/contracts';
import { useCallback, useEffect, useState } from 'react';
import { operationsApi } from '../lib/api';
import { BrandMark } from './BrandMark';

type Overview = Awaited<ReturnType<typeof operationsApi.overview>>;

const NAVIGATION = [
  'Overview',
  'Markets',
  'Market Templates',
  'Orders and Trades',
  'Price Feeds',
  'Resolutions',
  'Disputes',
  'Ledger',
  'Deposits',
  'Withdrawals',
  'Reconciliation',
  'Customers',
  'KYC and AML',
  'Risk Cases',
  'Fees',
  'Providers',
  'Notifications',
  'Incidents',
  'Audit Log',
  'Settings',
];

const RECORD_MODULES: Record<string, string> = {
  'Price Feeds': 'price-feeds',
  Resolutions: 'resolutions',
  Ledger: 'ledger',
  Deposits: 'deposits',
  Withdrawals: 'withdrawals',
  Reconciliation: 'reconciliation',
  'KYC and AML': 'compliance/cases',
  'Audit Log': 'audit',
};

export function OperationsDashboard() {
  const [user, setUser] = useState<AuthenticatedUser>();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [overview, setOverview] = useState<Overview>();
  const [selected, setSelected] = useState<Market>();
  const [activeModule, setActiveModule] = useState('Overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposalRef, setProposalRef] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);

  const refresh = useCallback(async () => {
    const [nextUser, nextMarkets, nextOverview] = await Promise.all([
      operationsApi.me(),
      operationsApi.markets(),
      operationsApi.overview(),
    ]);
    setUser(nextUser);
    setMarkets(nextMarkets.items);
    setOverview(nextOverview);
    setSelected((current) =>
      current
        ? nextMarkets.items.find((market) => market.marketRef === current.marketRef)
        : undefined,
    );
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      const value = cause as Error & { status?: number };
      if (value.status === 401) window.location.assign(operationsApi.loginUrl());
      else setError(value.message || 'Operations data could not be loaded.');
    });
  }, [refresh]);

  useEffect(() => {
    const path = RECORD_MODULES[activeModule];
    if (!path) {
      setRecords([]);
      return;
    }
    setError('');
    void operationsApi
      .records(path)
      .then(setRecords)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Module data could not be loaded.'),
      );
  }, [activeModule]);

  async function transition(action: string, reason: string) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      setSelected(await operationsApi.transition(selected.marketRef, action, reason));
      setNotice(`Market action completed: ${action}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Market action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function propose(outcomeRef: string) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const contentHash = await sha256(
        `${selected.marketRef}:${outcomeRef}:${selected.resolutionSource}`,
      );
      const proposal = await operationsApi.proposeResolution(selected.marketRef, {
        outcomeRef,
        reason:
          'The retained primary-source evidence supports this outcome under the immutable market rules.',
        evidence: [
          {
            source: selected.resolutionSource,
            capturedAt: new Date().toISOString(),
            contentHash,
            notes:
              'Evidence was captured by the authenticated resolution officer and must be retained in immutable object storage.',
          },
        ],
      });
      setProposalRef(proposal.proposalRef);
      setNotice('Resolution proposed. An independent authorized officer must approve it.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Resolution proposal failed.');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!proposalRef) return;
    setBusy(true);
    try {
      const result = await operationsApi.approveResolution(
        proposalRef,
        'Evidence and the immutable calculation rules were independently reviewed.',
      );
      setSelected(result.market);
      setProposalRef('');
      setNotice('Independent resolution approval recorded.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-shell">
      <aside className="sidebar">
        <div className="ops-brand">
          <BrandMark />
          <b>Zoryqon</b>
          <small>operations</small>
        </div>
        <nav>
          {NAVIGATION.map((item) => (
            <button
              className={item === activeModule ? 'active' : ''}
              key={item}
              onClick={() => setActiveModule(item)}
            >
              <span>◇</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="health-dot" /> Protected operations<small>Production data only</small>
        </div>
      </aside>
      <main className="ops-main">
        <header>
          <div>
            <span className="kicker">Control room</span>
            <h1>{activeModule}</h1>
          </div>
          {user && (
            <div className="operator">
              <span>{user.displayName.slice(0, 2).toUpperCase()}</span>
              <div>
                <b>{user.displayName}</b>
                <small>{user.roles.join(', ')}</small>
              </div>
            </div>
          )}
        </header>
        {error && (
          <div className="alert danger">
            <b>Action required</b>
            {error}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}
        {notice && (
          <div className="alert success">
            <b>Completed</b>
            {notice}
            <button onClick={() => setNotice('')}>×</button>
          </div>
        )}
        {activeModule === 'Overview' && (
          <section className="metric-grid">
            <Metric
              label="Open markets"
              value={overview?.open_markets ?? '—'}
              detail="server-authoritative"
            />
            <Metric
              label="Pending resolutions"
              value={overview?.pending_resolutions ?? '—'}
              detail="independent approval"
            />
            <Metric
              label="Pending withdrawals"
              value={overview?.pending_withdrawals ?? '—'}
              detail="provider and risk workflow"
            />
            <Metric
              label="Ledger differences"
              value={overview?.ledger_difference_count ?? '—'}
              detail="must remain zero"
              good={overview?.ledger_difference_count === '0'}
            />
            <Metric
              label="Compliance cases"
              value={overview?.open_compliance_cases ?? '—'}
              detail="open cases"
            />
            <Metric
              label="Critical reconciliation"
              value={overview?.critical_reconciliation_cases ?? '—'}
              detail="blocking controls"
              good={overview?.critical_reconciliation_cases === '0'}
            />
          </section>
        )}
        {(activeModule === 'Overview' || activeModule === 'Markets') && (
          <section className="ops-card market-table-card">
            <div className="card-title">
              <div>
                <span className="kicker">Market lifecycle</span>
                <h2>Markets</h2>
              </div>
              <div>
                <button onClick={() => setShowCreate(true)}>Create market</button>
                <button onClick={() => void refresh()}>Refresh</button>
              </div>
            </div>
            <div className="market-table">
              <div className="market-row market-head">
                <span>Market</span>
                <span>Status</span>
                <span>Product</span>
                <span>Closes</span>
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
                    {market.status.replaceAll('_', ' ')}
                  </span>
                  <span>{market.productType}</span>
                  <span>
                    {new Date(market.closesAt).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                  </span>
                  <span>›</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {(activeModule === 'Overview' || activeModule === 'Markets') && selected && (
          <section className="ops-card resolution-panel">
            <div className="card-title">
              <div>
                <span className="kicker">Selected market</span>
                <h2>{selected.title}</h2>
              </div>
              <span className={`large-status status-${selected.status}`}>
                {selected.status.replaceAll('_', ' ')}
              </span>
            </div>
            <div className="resolution-actions">
              {selected.status === 'draft' && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void transition('submit', 'Market submitted for independent review.')
                  }
                >
                  Submit for review
                </button>
              )}
              {selected.status === 'under_review' && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void transition('approve', 'Market rules, sources and controls approved.')
                  }
                >
                  Approve market
                </button>
              )}
              {selected.status === 'approved' && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void transition('publish', 'Approved market scheduled for publication.')
                  }
                >
                  Schedule publication
                </button>
              )}
              {selected.status === 'open' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void transition('suspend', 'Trading suspended by operations review.')
                    }
                  >
                    Suspend trading
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void transition('close', 'Market observation window ended.')}
                  >
                    Close for resolution
                  </button>
                </>
              )}
              {selected.status === 'suspended' && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void transition('resume', 'Suspension reason cleared.')}
                >
                  Resume trading
                </button>
              )}
              {selected.status === 'resolution_pending' &&
                !proposalRef &&
                selected.outcomes.map((outcome) => (
                  <button
                    className="primary"
                    disabled={busy}
                    key={outcome.outcomeRef}
                    onClick={() => void propose(outcome.outcomeRef)}
                  >
                    Propose {outcome.label}
                  </button>
                ))}
              {proposalRef && (
                <button className="primary" disabled={busy} onClick={() => void approve()}>
                  Approve as independent officer
                </button>
              )}
            </div>
          </section>
        )}
        {RECORD_MODULES[activeModule] && (
          <section className="ops-card market-table-card">
            <div className="card-title">
              <div>
                <span className="kicker">Authoritative records</span>
                <h2>{activeModule}</h2>
              </div>
            </div>
            <div className="market-table">
              {records.map((record, index) => (
                <div
                  className="market-row"
                  key={String(
                    record.event_ref ??
                      record.deposit_ref ??
                      record.withdrawal_ref ??
                      record.journal_ref ??
                      index,
                  )}
                >
                  <span>
                    <b>
                      {String(
                        record.event_ref ??
                          record.deposit_ref ??
                          record.withdrawal_ref ??
                          record.journal_ref ??
                          record.case_ref ??
                          record.run_ref ??
                          record.provider_ref ??
                          'Record',
                      )}
                    </b>
                    <small>
                      {Object.entries(record)
                        .map(([key, value]) => `${key}: ${String(value ?? '—')}`)
                        .join(' · ')}
                    </small>
                    {activeModule === 'Resolutions' && record.status === 'proposed' && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={async () => {
                          setProposalRef(String(record.proposal_ref));
                          await operationsApi.approveResolution(
                            String(record.proposal_ref),
                            'Evidence and immutable market rules were independently reviewed.',
                          );
                          setNotice('Independent resolution approval recorded.');
                          setRecords(await operationsApi.records('resolutions'));
                        }}
                      >
                        Approve resolution
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {records.length === 0 && (
                <div className="market-row">
                  <span>No records are currently available.</span>
                </div>
              )}
            </div>
          </section>
        )}
        {!RECORD_MODULES[activeModule] && !['Overview', 'Markets'].includes(activeModule) && (
          <section className="ops-card">
            <span className="kicker">Unavailable</span>
            <h2>{activeModule}</h2>
            <p>
              This workflow is not activated in the current release. No placeholder health or
              financial values are shown.
            </p>
          </section>
        )}
        {showCreate && (
          <CreateMarketPanel
            onClose={() => setShowCreate(false)}
            onCreated={async () => {
              setShowCreate(false);
              await refresh();
            }}
          />
        )}
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  good = false,
}: {
  label: string;
  value: string;
  detail: string;
  good?: boolean;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong className={good ? 'good' : ''}>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function CreateMarketPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const now = Date.now();
  const [input, setInput] = useState<CreateMarket>({
    title: '',
    question: '',
    categoryRef: '',
    productRef: '',
    outcomes: [{ label: 'Yes' }, { label: 'No' }],
    rules: '',
    primarySource: '',
    backupSource: null,
    priceIndexRef: null,
    opensAt: new Date(now + 3_600_000).toISOString(),
    closesAt: new Date(now + 86_400_000).toISOString(),
    resolutionAt: new Date(now + 90_000_000).toISOString(),
    displayTimezone: 'UTC',
    collateralAsset: 'USD',
    payoutAtoms: '100',
    tickAtoms: '1',
    minimumOrderQuantity: '1',
    maximumPositionQuantity: '10000',
    feeScheduleRef: '',
    jurisdictionPolicyRef: '',
    riskClass: 'standard',
  });
  const [error, setError] = useState('');
  async function submit() {
    try {
      await operationsApi.createMarket(input);
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Market creation failed.');
    }
  }
  return (
    <div className="modal-backdrop">
      <section className="ops-card create-panel">
        <div className="card-title">
          <h2>Create market</h2>
          <button onClick={onClose}>×</button>
        </div>
        {(
          [
            'title',
            'question',
            'categoryRef',
            'productRef',
            'feeScheduleRef',
            'jurisdictionPolicyRef',
            'primarySource',
            'backupSource',
            'priceIndexRef',
            'opensAt',
            'closesAt',
            'resolutionAt',
            'displayTimezone',
            'collateralAsset',
            'payoutAtoms',
            'tickAtoms',
            'minimumOrderQuantity',
            'maximumPositionQuantity',
            'rules',
          ] as const
        ).map((key) => (
          <label key={key}>
            {label(key)}
            {key === 'rules' ? (
              <textarea
                value={String(input[key] ?? '')}
                onChange={(event) => setInput({ ...input, [key]: event.target.value })}
              />
            ) : (
              <input
                value={String(input[key] ?? '')}
                onChange={(event) => setInput({ ...input, [key]: event.target.value })}
              />
            )}
          </label>
        ))}
        <div className="resolution-actions">
          {input.outcomes.map((outcome, index) => (
            <label key={index}>
              Outcome {index + 1}
              <input
                value={outcome.label}
                onChange={(event) =>
                  setInput({
                    ...input,
                    outcomes: input.outcomes.map((value, outcomeIndex) =>
                      outcomeIndex === index ? { label: event.target.value } : value,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() => setInput({ ...input, outcomes: [...input.outcomes, { label: '' }] })}
          >
            Add outcome
          </button>
        </div>
        <div className="resolution-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()}>
            Create draft
          </button>
        </div>
        {error && <div className="alert danger">{error}</div>}
      </section>
    </div>
  );
}

function label(value: string) {
  return value.replaceAll(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase());
}
async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
