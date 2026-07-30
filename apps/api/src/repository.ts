import { createHash } from 'node:crypto';
import type {
  AuthenticatedUser,
  Balance,
  CreateDeposit,
  CreateMarket,
  CreateWithdrawal,
  Deposit,
  FeeQuote,
  Market,
  MarketHistoryPoint,
  MarketQuery,
  Order,
  OrderQuoteRequest,
  Page,
  PlaceOrder,
  Position,
  ProposeResolution,
  StartVerification,
  Trade,
  VerificationStatus,
  Withdrawal,
  LedgerTransaction,
} from '@kynorix/contracts';
import { assertBalancedPostings, basisPointsCeil, externalRef } from '@kynorix/core';
import type { PoolClient, QueryResultRow } from 'pg';
import type { AuthPrincipal } from './auth.js';
import type { ApiConfig } from './config.js';
import type { Database } from './database.js';
import type { ProviderRegistry, VerifiedProviderEvent } from './providers.js';

type SqlClient = Pick<PoolClient, 'query'>;

export class KynorixRepository {
  constructor(
    private readonly database: Database,
    private readonly config: ApiConfig,
    private readonly providers: ProviderRegistry,
  ) {}

  async listMarkets(query: MarketQuery, includeNonPublic = false): Promise<Page<Market>> {
    const offset = decodeCursor(query.cursor);
    const sort = {
      trending: 'm.featured desc, coalesce(s.volume_atoms, 0) desc, m.created_at desc',
      volume: 'coalesce(s.volume_atoms, 0) desc, m.created_at desc',
      liquidity: 'coalesce(s.liquidity_atoms, 0) desc, m.created_at desc',
      newest: 'm.created_at desc',
      ending_soon: 'm.closes_at asc, m.created_at desc',
    }[query.sort];
    const values: unknown[] = [];
    const where = [
      includeNonPublic
        ? 'true'
        : query.status
          ? "m.status in ('open','suspended','closing','closed','resolution_pending','proposed','disputed','resolved','settling','settled','voided')"
          : "m.status in ('open','suspended')",
    ];
    if (query.status) {
      values.push(query.status);
      where.push(`m.status = $${values.length}`);
    }
    if (query.category) {
      values.push(query.category);
      where.push(`c.category_ref = $${values.length}`);
    }
    if (query.query) {
      values.push(query.query);
      where.push(
        `to_tsvector('english', m.title || ' ' || m.question) @@ websearch_to_tsquery('english', $${values.length})`,
      );
    }
    values.push(query.limit + 1, offset);
    const rows = await this.database.query<MarketRow>(
      `${marketSelect()}
       where ${where.join(' and ')}
       order by ${sort}
       limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    const items = rows.rows.slice(0, query.limit).map(mapMarket);
    return {
      items,
      nextCursor: rows.rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
    };
  }

  async getMarket(marketRef: string, includeNonPublic = false): Promise<Market> {
    const result = await this.database.query<MarketRow>(
      `${marketSelect()} where m.market_ref = $1
       ${includeNonPublic ? '' : "and m.status in ('open','suspended','closing','closed','resolution_pending','proposed','disputed','resolved','settling','settled','voided')"}`,
      [marketRef],
    );
    const row = result.rows[0];
    if (!row) throw domainError('MARKET_NOT_FOUND', 'Market not found.', 404);
    return mapMarket(row);
  }

  async listCategories(): Promise<Array<{ categoryRef: string; name: string }>> {
    const result = await this.database.query<{ category_ref: string; name: string }>(
      `select category_ref, name from public.market_categories
       where enabled order by display_order, name`,
    );
    return result.rows.map((row) => ({ categoryRef: row.category_ref, name: row.name }));
  }

  async listAssets(): Promise<Array<{ symbol: string; name: string; decimals: number }>> {
    const result = await this.database.query<{
      symbol: string;
      display_name: string;
      decimals: number;
    }>('select symbol, display_name, decimals from public.assets where enabled order by symbol');
    return result.rows.map((row) => ({
      symbol: row.symbol,
      name: row.display_name,
      decimals: row.decimals,
    }));
  }

  async getOrderbook(marketRef: string, outcomeRef?: string) {
    const market = await this.getMarket(marketRef);
    const selected = outcomeRef ?? market.outcomes[0]?.outcomeRef;
    if (!selected || !market.outcomes.some((outcome) => outcome.outcomeRef === selected)) {
      throw domainError('OUTCOME_NOT_FOUND', 'Outcome not found.', 404);
    }
    const result = await this.database.query<{
      side: 'buy' | 'sell';
      price_atoms: string;
      quantity: string;
      sequence: string;
    }>(
      `select o.side::text, o.price_atoms::text,
        sum(o.remaining_quantity)::text as quantity,
        max(o.book_sequence)::text as sequence
       from public.orders o
       join public.markets m on m.id = o.market_id
       join public.market_outcomes mo on mo.id = o.outcome_id
       where m.market_ref = $1 and mo.outcome_ref = $2
         and o.status in ('open','partially_filled')
       group by o.side, o.price_atoms
       order by case when o.side = 'buy' then o.price_atoms end desc,
                case when o.side = 'sell' then o.price_atoms end asc
       limit 100`,
      [marketRef, selected],
    );
    const sequence = await this.database.query<{ last_sequence: string }>(
      `select bs.last_sequence::text
       from public.market_book_sequences bs
       join public.markets m on m.id = bs.market_id
       join public.market_outcomes mo on mo.id = bs.outcome_id
       where m.market_ref = $1 and mo.outcome_ref = $2`,
      [marketRef, selected],
    );
    return {
      marketRef,
      outcomeRef: selected,
      sequence: sequence.rows[0]?.last_sequence ?? '0',
      bids: result.rows
        .filter((row) => row.side === 'buy')
        .map(({ price_atoms, quantity }) => ({ priceAtoms: price_atoms, quantity })),
      asks: result.rows
        .filter((row) => row.side === 'sell')
        .map(({ price_atoms, quantity }) => ({ priceAtoms: price_atoms, quantity })),
    };
  }

  async listTrades(marketRef: string, limit: number): Promise<Trade[]> {
    const result = await this.database.query<TradeRow>(
      `select t.trade_ref, m.market_ref, mo.outcome_ref,
        maker.order_ref as maker_order_ref, taker.order_ref as taker_order_ref,
        t.price_atoms::text, t.quantity::text, t.buyer_fee_atoms::text,
        t.seller_fee_atoms::text, t.book_sequence::text, t.executed_at::text
       from public.trades t
       join public.markets m on m.id = t.market_id
       join public.market_outcomes mo on mo.id = t.outcome_id
       join public.orders maker on maker.id = t.maker_order_id
       join public.orders taker on taker.id = t.taker_order_id
       where m.market_ref = $1
       order by t.book_sequence desc limit $2`,
      [marketRef, Math.min(500, Math.max(1, limit))],
    );
    return result.rows.map(mapTrade);
  }

  async marketHistory(
    marketRef: string,
    outcomeRef: string,
    range: '1H' | '6H' | '1D' | '1W' | '1M' | 'ALL',
  ): Promise<MarketHistoryPoint[]> {
    const interval = {
      '1H': "interval '1 hour'",
      '6H': "interval '6 hours'",
      '1D': "interval '1 day'",
      '1W': "interval '7 days'",
      '1M': "interval '30 days'",
      ALL: null,
    }[range];
    const result = await this.database.query<{
      observed_at: string;
      outcome_ref: string;
      price_atoms: string;
      volume_atoms: string;
    }>(
      `select h.observed_at::text, mo.outcome_ref, h.price_atoms::text, h.volume_atoms::text
       from public.market_price_history h
       join public.markets m on m.id = h.market_id
       join public.market_outcomes mo on mo.id = h.outcome_id
       where m.market_ref = $1 and mo.outcome_ref = $2
       ${interval ? `and h.observed_at >= clock_timestamp() - ${interval}` : ''}
       order by h.observed_at`,
      [marketRef, outcomeRef],
    );
    return result.rows.map((row) => ({
      timestamp: new Date(row.observed_at).toISOString(),
      outcomeRef: row.outcome_ref,
      priceAtoms: row.price_atoms,
      volumeAtoms: row.volume_atoms,
    }));
  }

  me(principal: AuthPrincipal): AuthenticatedUser {
    return principal;
  }

  async balances(principal: AuthPrincipal): Promise<Balance[]> {
    const result = await this.database.query<{
      symbol: string;
      decimals: number;
      available_atoms: string;
      locked_atoms: string;
      pending_deposit_atoms: string;
      pending_withdrawal_atoms: string;
    }>(
      `select a.symbol, a.decimals,
        coalesce(sum(b.balance_atoms) filter (where la.account_type in ('customer_available','customer_asset_available')), 0)::text as available_atoms,
        coalesce(sum(b.balance_atoms) filter (where la.account_type in ('customer_locked','customer_asset_locked','collateral_locked')), 0)::text as locked_atoms,
        coalesce(sum(b.balance_atoms) filter (where la.account_type = 'customer_pending_deposit'), 0)::text as pending_deposit_atoms,
        coalesce(sum(b.balance_atoms) filter (where la.account_type = 'customer_pending_withdrawal'), 0)::text as pending_withdrawal_atoms
       from public.ledger_accounts la
       join public.assets a on a.id = la.asset_id
       left join public.ledger_account_balances b on b.account_id = la.id
       where la.tenant_id = $1 and la.owner_user_id = $2
       group by a.id order by a.symbol`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map((row) => ({
      asset: row.symbol,
      decimals: row.decimals,
      availableAtoms: row.available_atoms,
      lockedAtoms: row.locked_atoms,
      pendingDepositAtoms: row.pending_deposit_atoms,
      pendingWithdrawalAtoms: row.pending_withdrawal_atoms,
    }));
  }

  async positions(principal: AuthPrincipal): Promise<Position[]> {
    const result = await this.database.query<{
      market_ref: string;
      market_title: string;
      market_status: Position['marketStatus'];
      outcome_ref: string;
      outcome_label: string;
      available_quantity: string;
      locked_quantity: string;
      average_entry_price_atoms: string;
      current_price_atoms: string | null;
      position_value_atoms: string;
      potential_payout_atoms: string;
      unrealized_pnl_atoms: string;
      realized_pnl_atoms: string;
      fees_paid_atoms: string;
    }>(
      `select m.market_ref, m.title as market_title, m.status::text as market_status,
        mo.outcome_ref, mo.label as outcome_label, p.available_quantity::text,
        p.locked_quantity::text,
        case when p.available_quantity + p.locked_quantity = 0 then '0'
          else (p.cost_atoms / (p.available_quantity + p.locked_quantity))::text end as average_entry_price_atoms,
        s.last_price_atoms::text as current_price_atoms,
        (coalesce(s.last_price_atoms, 0) * (p.available_quantity + p.locked_quantity))::text as position_value_atoms,
        (m.payout_atoms * (p.available_quantity + p.locked_quantity))::text as potential_payout_atoms,
        (coalesce(s.last_price_atoms, 0) * (p.available_quantity + p.locked_quantity) - p.cost_atoms)::text as unrealized_pnl_atoms,
        p.realized_pnl_atoms::text, p.fees_paid_atoms::text
       from public.positions p
       join public.markets m on m.id = p.market_id
       join public.market_outcomes mo on mo.id = p.outcome_id
       left join public.market_price_snapshots s on s.market_id = p.market_id and s.outcome_id = p.outcome_id
       where p.tenant_id = $1 and p.user_id = $2
         and (p.available_quantity > 0 or p.locked_quantity > 0 or p.realized_pnl_atoms <> 0)
       order by p.updated_at desc`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map((row) => ({
      marketRef: row.market_ref,
      marketTitle: row.market_title,
      marketStatus: row.market_status,
      outcomeRef: row.outcome_ref,
      outcomeLabel: row.outcome_label,
      availableQuantity: row.available_quantity,
      lockedQuantity: row.locked_quantity,
      averageEntryPriceAtoms: row.average_entry_price_atoms,
      currentPriceAtoms: row.current_price_atoms,
      positionValueAtoms: row.position_value_atoms,
      potentialPayoutAtoms: row.potential_payout_atoms,
      unrealizedPnlAtoms: row.unrealized_pnl_atoms,
      realizedPnlAtoms: row.realized_pnl_atoms,
      feesPaidAtoms: row.fees_paid_atoms,
    }));
  }

  async orders(principal: AuthPrincipal): Promise<Order[]> {
    const result = await this.database.query<OrderRow>(
      `${orderSelect()} where o.tenant_id = $1 and o.user_id = $2 order by o.created_at desc limit 500`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map(mapOrder);
  }

  async userTrades(principal: AuthPrincipal): Promise<Trade[]> {
    const result = await this.database.query<TradeRow>(
      `select t.trade_ref, m.market_ref, mo.outcome_ref,
        maker.order_ref as maker_order_ref, taker.order_ref as taker_order_ref,
        t.price_atoms::text, t.quantity::text, t.buyer_fee_atoms::text,
        t.seller_fee_atoms::text, t.book_sequence::text, t.executed_at::text
       from public.trades t
       join public.markets m on m.id = t.market_id
       join public.market_outcomes mo on mo.id = t.outcome_id
       join public.orders maker on maker.id = t.maker_order_id
       join public.orders taker on taker.id = t.taker_order_id
       where t.tenant_id = $1 and (t.buyer_user_id = $2 or t.seller_user_id = $2)
       order by t.executed_at desc limit 500`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map(mapTrade);
  }

  async ledger(principal: AuthPrincipal): Promise<LedgerTransaction[]> {
    const result = await this.database.query<{
      journal_ref: string;
      transaction_type: string;
      asset: string;
      reference_type: string;
      reference_ref: string;
      effective_at: string;
      debit_atoms: string;
      credit_atoms: string;
    }>(
      `select lj.journal_ref, lj.transaction_type, a.symbol as asset,
        lj.reference_type, lj.reference_ref, lj.effective_at::text,
        coalesce(sum(le.debit_atoms),0)::text as debit_atoms,
        coalesce(sum(le.credit_atoms),0)::text as credit_atoms
       from public.ledger_journals lj
       join public.assets a on a.id = lj.asset_id
       join public.ledger_entries le on le.journal_id = lj.id
       join public.ledger_accounts la on la.id = le.account_id
       where lj.tenant_id = $1 and la.owner_user_id = $2
       group by lj.id, a.symbol order by lj.effective_at desc limit 1000`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map((row) => ({
      journalRef: row.journal_ref,
      transactionType: row.transaction_type,
      asset: row.asset,
      referenceType: row.reference_type,
      referenceRef: row.reference_ref,
      effectiveAt: new Date(row.effective_at).toISOString(),
      debitAtoms: row.debit_atoms,
      creditAtoms: row.credit_atoms,
    }));
  }

  async verification(principal: AuthPrincipal): Promise<VerificationStatus> {
    const result = await this.database.query<{
      case_ref: string;
      status: string;
      required_level: string;
      action_url: string | null;
      opened_at: string;
      decided_at: string | null;
    }>(
      `select case_ref, status, required_level, action_url, opened_at::text, decided_at::text
       from public.kyc_cases where tenant_id = $1 and user_id = $2
       order by opened_at desc limit 1`,
      [principal.tenantId, principal.userId],
    );
    const row = result.rows[0];
    return row
      ? {
          level: row.required_level,
          status: row.status,
          caseRef: row.case_ref,
          actionUrl: row.action_url,
          openedAt: new Date(row.opened_at).toISOString(),
          decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
        }
      : {
          level: principal.kycLevel,
          status: principal.kycLevel === 'unverified' ? 'not_started' : 'verified',
          caseRef: null,
          actionUrl: null,
          openedAt: null,
          decidedAt: null,
        };
  }

  async startVerification(
    principal: AuthPrincipal,
    input: StartVerification,
  ): Promise<VerificationStatus> {
    const fingerprint = requestFingerprint(input);
    const existing = await this.database.query<{
      case_ref: string;
      request_fingerprint: string;
    }>(
      `select case_ref, request_fingerprint from public.kyc_cases
       where tenant_id = $1 and user_id = $2 and idempotency_key = $3
       order by opened_at desc limit 1`,
      [principal.tenantId, principal.userId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was used for a different verification request.',
          409,
        );
      }
      return this.verification(principal);
    }

    const caseRef = externalRef('kyc');
    await this.database.query(
      `insert into public.kyc_cases
       (tenant_id, case_ref, user_id, status, required_level, idempotency_key, request_fingerprint)
       values ($1,$2,$3,'created',$4,$5,$6)`,
      [
        principal.tenantId,
        caseRef,
        principal.userId,
        input.requiredLevel,
        input.idempotencyKey,
        fingerprint,
      ],
    );
    try {
      const session = await this.providers.createVerification(caseRef, principal.userRef, input);
      await this.database.query(
        `update public.kyc_cases set provider_ref = $1, status = $2, action_url = $3
         where tenant_id = $4 and case_ref = $5`,
        [session.providerCaseRef, session.status, session.actionUrl, principal.tenantId, caseRef],
      );
      return this.verification(principal);
    } catch (error) {
      await this.database.query(
        `update public.kyc_cases set status = 'provider_unavailable'
         where tenant_id = $1 and case_ref = $2`,
        [principal.tenantId, caseRef],
      );
      throw error;
    }
  }

  async sessions(principal: AuthPrincipal) {
    const result = await this.database.query<{
      session_ref: string;
      device_ref: string | null;
      ip: string | null;
      user_agent: string | null;
      mfa_verified: boolean;
      last_seen_at: string;
      expires_at: string;
      created_at: string;
    }>(
      `select session_ref,device_ref,host(ip)::text as ip,user_agent,mfa_verified,
        last_seen_at::text,expires_at::text,created_at::text
       from public.user_sessions where user_id = $1 and revoked_at is null
         and expires_at > clock_timestamp() order by last_seen_at desc`,
      [principal.userId],
    );
    return result.rows.map((row) => ({
      sessionRef: row.session_ref,
      deviceRef: row.device_ref,
      ip: row.ip,
      userAgent: row.user_agent,
      mfaVerified: row.mfa_verified,
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async revokeSession(principal: AuthPrincipal, sessionRef: string): Promise<{ revoked: boolean }> {
    const result = await this.database.query(
      `update public.user_sessions set revoked_at = clock_timestamp()
       where user_id = $1 and session_ref = $2 and revoked_at is null`,
      [principal.userId, sessionRef],
    );
    return { revoked: Boolean(result.rowCount) };
  }

  async notificationPreferences(principal: AuthPrincipal) {
    const result = await this.database.query<{
      email_enabled: boolean;
      push_enabled: boolean;
      in_app_enabled: boolean;
      security_sms_enabled: boolean;
      market_closing_enabled: boolean;
    }>(
      `insert into public.notification_preferences (user_id) values ($1)
       on conflict (user_id) do update set user_id = excluded.user_id
       returning email_enabled,push_enabled,in_app_enabled,security_sms_enabled,
         market_closing_enabled`,
      [principal.userId],
    );
    const row = result.rows[0]!;
    return {
      emailEnabled: row.email_enabled,
      pushEnabled: row.push_enabled,
      inAppEnabled: row.in_app_enabled,
      securitySmsEnabled: row.security_sms_enabled,
      marketClosingEnabled: row.market_closing_enabled,
    };
  }

  async updateNotificationPreferences(
    principal: AuthPrincipal,
    input: {
      emailEnabled: boolean;
      pushEnabled: boolean;
      inAppEnabled: boolean;
      securitySmsEnabled: boolean;
      marketClosingEnabled: boolean;
    },
  ) {
    await this.database.query(
      `insert into public.notification_preferences
       (user_id,email_enabled,push_enabled,in_app_enabled,security_sms_enabled,
        market_closing_enabled)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (user_id) do update set
         email_enabled = excluded.email_enabled,
         push_enabled = excluded.push_enabled,
         in_app_enabled = excluded.in_app_enabled,
         security_sms_enabled = excluded.security_sms_enabled,
         market_closing_enabled = excluded.market_closing_enabled,
         updated_at = clock_timestamp()`,
      [
        principal.userId,
        input.emailEnabled,
        input.pushEnabled,
        input.inAppEnabled,
        input.securitySmsEnabled,
        input.marketClosingEnabled,
      ],
    );
    return this.notificationPreferences(principal);
  }

  async quoteOrder(principal: AuthPrincipal, input: OrderQuoteRequest): Promise<FeeQuote> {
    const market = await this.database.query<{
      id: string;
      outcome_id: string;
      asset_id: string;
      asset: string;
      payout_atoms: string;
      fee_schedule_id: string;
      fee_schedule_ref: string;
      fee_version: number;
      taker_basis_points: number;
      flat_atoms: string;
    }>(
      `select m.id, mo.id as outcome_id, a.id as asset_id, a.symbol as asset,
        m.payout_atoms::text, fs.id as fee_schedule_id, fs.fee_schedule_ref,
        fs.version as fee_version, coalesce(fr.taker_basis_points, 0) as taker_basis_points,
        coalesce(fr.flat_atoms, 0)::text as flat_atoms
       from public.markets m
       join public.market_outcomes mo on mo.market_id = m.id and mo.outcome_ref = $2
       join public.assets a on a.id = m.collateral_asset_id
       join public.fee_schedules fs on fs.id = m.fee_schedule_id and fs.status = 'active'
       left join lateral (
         select * from public.fee_rules r
         where r.fee_schedule_id = fs.id and r.fee_type = 'trading'
         order by r.market_ref nulls last, r.product_ref nulls last limit 1
       ) fr on true
       where m.tenant_id = $3 and m.market_ref = $1 and m.status = 'open'
         and not m.trading_suspended and clock_timestamp() between m.opens_at and m.closes_at`,
      [input.marketRef, input.outcomeRef, principal.tenantId],
    );
    const row = market.rows[0];
    if (!row) throw domainError('MARKET_NOT_OPEN', 'This market is not open for trading.', 409);
    const price = BigInt(input.priceAtoms);
    const quantity = BigInt(input.quantity);
    const value = price * quantity;
    const fee = basisPointsCeil(value, BigInt(row.taker_basis_points)) + BigInt(row.flat_atoms);
    const payout = BigInt(row.payout_atoms) * quantity;
    const totalDebit = input.side === 'buy' ? value + fee : fee;
    const quoteRef = externalRef('qte');
    const fingerprint = requestFingerprint(input);
    const bestOpposite = await this.database.query<{ price_atoms: string | null }>(
      `select case when $3 = 'buy' then min(o.price_atoms) else max(o.price_atoms) end::text as price_atoms
       from public.orders o
       where o.market_id = $1 and o.outcome_id = $2
         and o.side = case when $3 = 'buy' then 'sell'::public.order_side else 'buy'::public.order_side end
         and o.status in ('open','partially_filled')`,
      [row.id, row.outcome_id, input.side],
    );
    const best = bestOpposite.rows[0]?.price_atoms;
    const impact =
      best && BigInt(best) > 0n ? Number(((price - BigInt(best)) * 10_000n) / BigInt(best)) : 0;
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    await this.database.query(
      `insert into public.fee_quotes
       (tenant_id, quote_ref, user_id, market_id, outcome_id, fee_schedule_id,
        fee_schedule_version, request_fingerprint, order_value_atoms, fee_atoms,
        total_debit_atoms, potential_payout_atoms, price_impact_basis_points, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        principal.tenantId,
        quoteRef,
        principal.userId,
        row.id,
        row.outcome_id,
        row.fee_schedule_id,
        row.fee_version,
        fingerprint,
        value.toString(),
        fee.toString(),
        totalDebit.toString(),
        payout.toString(),
        impact,
        expiresAt,
      ],
    );
    return {
      quoteRef,
      marketRef: input.marketRef,
      outcomeRef: input.outcomeRef,
      asset: row.asset,
      priceAtoms: input.priceAtoms,
      quantity: input.quantity,
      orderValueAtoms: value.toString(),
      feeAtoms: fee.toString(),
      totalDebitAtoms: totalDebit.toString(),
      potentialPayoutAtoms: payout.toString(),
      potentialProfitAtoms: (payout - value - fee).toString(),
      priceImpactBasisPoints: impact,
      feeScheduleRef: row.fee_schedule_ref,
      feeScheduleVersion: row.fee_version,
      expiresAt,
    };
  }

  async placeOrder(principal: AuthPrincipal, input: PlaceOrder): Promise<Order> {
    return this.database.transaction(
      { tenantId: principal.tenantId, userId: principal.userId },
      async (client) => {
        const existing = await client.query<OrderRow>(
          `${orderSelect()} where o.tenant_id = $1 and o.user_id = $2 and o.idempotency_key = $3`,
          [principal.tenantId, principal.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_fingerprint !== requestFingerprint(input)) {
            throw domainError(
              'IDEMPOTENCY_CONFLICT',
              'This idempotency key was used for a different order.',
              409,
            );
          }
          return mapOrder(existing.rows[0]);
        }
        const quoteFingerprint = requestFingerprint({
          marketRef: input.marketRef,
          outcomeRef: input.outcomeRef,
          side: input.side,
          priceAtoms: input.priceAtoms,
          quantity: input.quantity,
          timeInForce: input.timeInForce,
          postOnly: input.postOnly,
          maximumSlippageBasisPoints: input.maximumSlippageBasisPoints,
        });
        const quote = await client.query<{
          id: string;
          market_id: string;
          outcome_id: string;
          fee_schedule_id: string;
          fee_schedule_version: number;
          fee_atoms: string;
          total_debit_atoms: string;
          request_fingerprint: string;
        }>(
          `select id, market_id, outcome_id, fee_schedule_id, fee_schedule_version,
            fee_atoms::text, total_debit_atoms::text, request_fingerprint
           from public.fee_quotes
           where tenant_id = $1 and quote_ref = $2 and user_id = $3
             and consumed_at is null and expires_at > clock_timestamp()
           for update`,
          [principal.tenantId, input.quoteRef, principal.userId],
        );
        const feeQuote = quote.rows[0];
        if (!feeQuote || feeQuote.request_fingerprint !== quoteFingerprint) {
          throw domainError('ORDER_QUOTE_INVALID', 'The order quote is invalid or expired.', 409);
        }
        const marketResult = await client.query<{
          id: string;
          outcome_id: string;
          asset_id: string;
          payout_atoms: string;
          tick_atoms: string;
          minimum_order_quantity: string;
          maximum_position_quantity: string;
        }>(
          `select m.id, mo.id as outcome_id, m.collateral_asset_id as asset_id,
            m.payout_atoms::text, m.tick_atoms::text, m.minimum_order_quantity::text,
            m.maximum_position_quantity::text
           from public.markets m
           join public.product_definitions pd on pd.id = m.product_definition_id and pd.status = 'approved'
           join public.jurisdiction_policies jp on jp.id = m.jurisdiction_policy_id and jp.status = 'active'
           join public.market_outcomes mo on mo.market_id = m.id and mo.outcome_ref = $2
           where m.tenant_id = $3 and m.market_ref = $1 and m.status = 'open'
             and not m.trading_suspended and clock_timestamp() between m.opens_at and m.closes_at
           for update of m`,
          [input.marketRef, input.outcomeRef, principal.tenantId],
        );
        const market = marketResult.rows[0];
        if (!market) {
          throw domainError('MARKET_NOT_OPEN', 'This market is not open for trading.', 409);
        }
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${market.id}:${market.outcome_id}`,
        ]);
        const price = BigInt(input.priceAtoms);
        const quantity = BigInt(input.quantity);
        if (
          price <= 0n ||
          price >= BigInt(market.payout_atoms) ||
          price % BigInt(market.tick_atoms) !== 0n
        ) {
          throw domainError('INVALID_PRICE', 'Price does not satisfy this market tick size.', 400);
        }
        if (quantity < BigInt(market.minimum_order_quantity)) {
          throw domainError('INVALID_QUANTITY', 'Quantity is below the market minimum.', 400);
        }
        if (input.side === 'buy') {
          const exposure = await client.query<{ quantity: string }>(
            `select (
              coalesce((select available_quantity + locked_quantity from public.positions
                where tenant_id = $1 and user_id = $2 and market_id = $3 and outcome_id = $4), 0)
              + coalesce((select sum(remaining_quantity) from public.orders
                where tenant_id = $1 and user_id = $2 and market_id = $3 and outcome_id = $4
                  and side = 'buy' and status in ('open','partially_filled')), 0)
            )::text as quantity`,
            [principal.tenantId, principal.userId, market.id, market.outcome_id],
          );
          if (
            BigInt(exposure.rows[0]!.quantity) + quantity >
            BigInt(market.maximum_position_quantity)
          ) {
            throw domainError(
              'POSITION_LIMIT_EXCEEDED',
              'This order would exceed the market position limit.',
              409,
            );
          }
        }

        const oppositeSide = input.side === 'buy' ? 'sell' : 'buy';
        const available = await client.query<{ available: string }>(
          `select coalesce(sum(remaining_quantity), 0)::text as available
           from public.orders where market_id = $1 and outcome_id = $2 and side = $3
             and status in ('open','partially_filled')
             and case when $4 = 'buy' then price_atoms <= $5 else price_atoms >= $5 end`,
          [market.id, market.outcome_id, oppositeSide, input.side, input.priceAtoms],
        );
        const executable = BigInt(available.rows[0]!.available);
        if (input.timeInForce === 'FOK' && executable < quantity) {
          throw domainError('FOK_NOT_FILLABLE', 'The order cannot be filled in full.', 409);
        }
        if (input.postOnly && executable > 0n) {
          throw domainError(
            'POST_ONLY_WOULD_TRADE',
            'Post-only order would execute immediately.',
            409,
          );
        }
        const selfTrade = await client.query(
          `select 1 from public.orders where user_id = $1 and market_id = $2 and outcome_id = $3
             and side = $4 and status in ('open','partially_filled')
             and case when $5 = 'buy' then price_atoms <= $6 else price_atoms >= $6 end limit 1`,
          [
            principal.userId,
            market.id,
            market.outcome_id,
            oppositeSide,
            input.side,
            input.priceAtoms,
          ],
        );
        if (selfTrade.rowCount) {
          throw domainError(
            'SELF_TRADE_PREVENTED',
            'This order would trade with your own order.',
            409,
          );
        }

        const orderRef = externalRef('ord');
        const sequence = await nextBookSequence(client, market.id, market.outcome_id);
        if (input.side === 'buy') {
          await reserveFunds(
            client,
            principal,
            market.asset_id,
            BigInt(feeQuote.total_debit_atoms),
            orderRef,
          );
        } else {
          await reservePosition(client, principal, market.id, market.outcome_id, quantity);
        }
        const inserted = await client.query<{ id: string }>(
          `insert into public.orders
           (tenant_id, order_ref, user_id, market_id, outcome_id, side, order_type,
            price_atoms, quantity, remaining_quantity, time_in_force, post_only, status,
            fee_schedule_id, fee_schedule_version, estimated_fee_atoms, actual_fee_atoms,
            idempotency_key, request_fingerprint, book_sequence)
           values ($1,$2,$3,$4,$5,$6,'limit',$7,$8,$8,$9,$10,'open',$11,$12,$13,0,$14,$15,$16)
           returning id`,
          [
            principal.tenantId,
            orderRef,
            principal.userId,
            market.id,
            market.outcome_id,
            input.side,
            input.priceAtoms,
            input.quantity,
            input.timeInForce,
            input.postOnly,
            feeQuote.fee_schedule_id,
            feeQuote.fee_schedule_version,
            feeQuote.fee_atoms,
            input.idempotencyKey,
            requestFingerprint(input),
            sequence,
          ],
        );
        const orderId = inserted.rows[0]!.id;
        await client.query(
          `insert into public.collateral_reservations
           (order_id, asset_id, amount_atoms, quantity, status)
           values ($1,$2,$3,$4,'active')`,
          [
            orderId,
            market.asset_id,
            input.side === 'buy' ? feeQuote.total_debit_atoms : '0',
            input.side === 'sell' ? input.quantity : '0',
          ],
        );
        await client.query(
          `insert into public.order_events (order_id, event_type, sequence, payload)
           values ($1, 'accepted', 1, jsonb_build_object('status','open'))`,
          [orderId],
        );
        await client.query(
          'update public.fee_quotes set consumed_at = clock_timestamp() where id = $1',
          [feeQuote.id],
        );
        await matchOrder(client, {
          tenantId: principal.tenantId,
          orderId,
          orderRef,
          userId: principal.userId,
          marketId: market.id,
          outcomeId: market.outcome_id,
          assetId: market.asset_id,
          side: input.side,
          priceAtoms: price,
          quantity,
          feeScheduleId: feeQuote.fee_schedule_id,
          feeScheduleVersion: feeQuote.fee_schedule_version,
        });
        if (input.timeInForce !== 'GTC') {
          await cancelRemainder(client, principal, orderId, orderRef);
        } else {
          await reconcileReservation(client, principal.tenantId, orderId);
        }
        await emitOutbox(
          client,
          principal.tenantId,
          `user.${principal.userRef}.orders`,
          'OrderChanged',
          {
            orderRef,
          },
        );
        await emitOutbox(
          client,
          principal.tenantId,
          `market.${input.marketRef}.book`,
          'OrderBookChanged',
          {
            marketRef: input.marketRef,
            outcomeRef: input.outcomeRef,
          },
        );
        const result = await client.query<OrderRow>(`${orderSelect()} where o.id = $1`, [orderId]);
        return mapOrder(result.rows[0]!);
      },
    );
  }

  async cancelOrder(principal: AuthPrincipal, orderRef: string): Promise<Order> {
    return this.database.transaction(
      { tenantId: principal.tenantId, userId: principal.userId },
      async (client) => {
        const row = await client.query<{ id: string; market_id: string; outcome_id: string }>(
          `select id, market_id, outcome_id from public.orders
           where tenant_id = $1 and user_id = $2 and order_ref = $3 for update`,
          [principal.tenantId, principal.userId, orderRef],
        );
        const order = row.rows[0];
        if (!order) throw domainError('ORDER_NOT_FOUND', 'Order not found.', 404);
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${order.market_id}:${order.outcome_id}`,
        ]);
        await cancelRemainder(client, principal, order.id, orderRef);
        await emitOutbox(
          client,
          principal.tenantId,
          `user.${principal.userRef}.orders`,
          'OrderCancelled',
          {
            orderRef,
          },
        );
        const result = await client.query<OrderRow>(`${orderSelect()} where o.id = $1`, [order.id]);
        return mapOrder(result.rows[0]!);
      },
    );
  }

  async deposits(principal: AuthPrincipal): Promise<Deposit[]> {
    const result = await this.database.query<DepositRow>(
      `select d.deposit_ref, d.method, a.symbol as asset, d.amount_atoms::text,
        d.fee_atoms::text, d.status::text, d.provider_transaction_ref,
        d.created_at::text, d.completed_at::text
       from public.deposits d join public.assets a on a.id = d.asset_id
       where d.tenant_id = $1 and d.user_id = $2 order by d.created_at desc`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map(mapDeposit);
  }

  async createDeposit(principal: AuthPrincipal, input: CreateDeposit) {
    if (!['basic', 'enhanced', 'institution'].includes(principal.kycLevel)) {
      throw domainError('KYC_UPGRADE_REQUIRED', 'Identity verification is required.', 403);
    }
    const intentRef = externalRef('dpi');
    const fingerprint = requestFingerprint(input);
    const asset = await this.database.query<{ id: string }>(
      'select id from public.assets where symbol = $1 and enabled',
      [input.asset],
    );
    if (!asset.rows[0]) throw domainError('ASSET_NOT_SUPPORTED', 'Asset is not supported.', 400);
    const created = await this.database.query<{
      intent_ref: string;
      provider_intent_ref: string | null;
      status: string;
      request_fingerprint: string;
    }>(
      `insert into public.deposit_intents
       (tenant_id, intent_ref, user_id, asset_id, method, amount_atoms, provider_ref,
        status, idempotency_key, request_fingerprint)
       values ($1,$2,$3,$4,$5,$6,'configured-payment-provider','created',$7,$8)
       on conflict (tenant_id,user_id,idempotency_key) do nothing
       returning intent_ref, provider_intent_ref, status::text, request_fingerprint`,
      [
        principal.tenantId,
        intentRef,
        principal.userId,
        asset.rows[0].id,
        input.method,
        input.amountAtoms,
        input.idempotencyKey,
        fingerprint,
      ],
    );
    if (!created.rows[0]) {
      const existing = await this.database.query<{
        intent_ref: string;
        provider_intent_ref: string | null;
        status: string;
        request_fingerprint: string;
      }>(
        `select intent_ref, provider_intent_ref, status::text, request_fingerprint
         from public.deposit_intents
         where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
        [principal.tenantId, principal.userId, input.idempotencyKey],
      );
      const prior = existing.rows[0]!;
      if (prior.request_fingerprint !== fingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was used for a different deposit.',
          409,
        );
      }
      return {
        intentRef: prior.intent_ref,
        providerIntentRef: prior.provider_intent_ref,
        status: prior.status,
      };
    }
    try {
      const session = await this.providers.createDeposit(intentRef, principal.userRef, input);
      await this.database.query(
        `update public.deposit_intents set provider_intent_ref = $1, status = $2,
          expires_at = $3 where tenant_id = $4 and intent_ref = $5`,
        [
          session.providerIntentRef,
          session.status,
          session.expiresAt ?? null,
          principal.tenantId,
          intentRef,
        ],
      );
      return { intentRef, ...session };
    } catch (error) {
      await this.database.query(
        `update public.deposit_intents set status = 'failed'
         where tenant_id = $1 and intent_ref = $2`,
        [principal.tenantId, intentRef],
      );
      throw error;
    }
  }

  async withdrawals(principal: AuthPrincipal): Promise<Withdrawal[]> {
    const result = await this.database.query<WithdrawalRow>(
      `select wr.withdrawal_ref, wr.method, a.symbol as asset, wr.amount_atoms::text,
        wr.fee_atoms::text, coalesce(w.status, wr.status)::text as status,
        w.provider_transaction_ref, wr.requested_at::text as created_at,
        w.completed_at::text
       from public.withdrawal_requests wr
       join public.assets a on a.id = wr.asset_id
       left join public.withdrawals w on w.withdrawal_request_id = wr.id
       where wr.tenant_id = $1 and wr.user_id = $2 order by wr.requested_at desc`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map(mapWithdrawal);
  }

  async createWithdrawal(principal: AuthPrincipal, input: CreateWithdrawal): Promise<Withdrawal> {
    if (!['basic', 'enhanced', 'institution'].includes(principal.kycLevel)) {
      throw domainError('KYC_UPGRADE_REQUIRED', 'Identity verification is required.', 403);
    }
    const requestedRef = externalRef('wdr');
    const fingerprint = requestFingerprint(input);
    const withdrawalRef = await this.database.transaction(
      { tenantId: principal.tenantId, userId: principal.userId },
      async (client) => {
        const asset = await client.query<{ id: string }>(
          'select id from public.assets where symbol = $1 and enabled',
          [input.asset],
        );
        if (!asset.rows[0])
          throw domainError('ASSET_NOT_SUPPORTED', 'Asset is not supported.', 400);
        const existing = await client.query<{
          withdrawal_ref: string;
          request_fingerprint: string;
        }>(
          `select withdrawal_ref, request_fingerprint from public.withdrawal_requests
           where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
          [principal.tenantId, principal.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_fingerprint !== fingerprint) {
            throw domainError(
              'IDEMPOTENCY_CONFLICT',
              'This idempotency key was used for a different withdrawal.',
              409,
            );
          }
          return existing.rows[0].withdrawal_ref;
        }
        const amount = BigInt(input.amountAtoms);
        await reserveWithdrawal(client, principal, asset.rows[0].id, amount, requestedRef);
        await client.query(
          `insert into public.withdrawal_requests
           (tenant_id, withdrawal_ref, user_id, asset_id, method, destination_ref,
            amount_atoms, status, idempotency_key, request_fingerprint)
           values ($1,$2,$3,$4,$5,$6,$7,'authentication_required',$8,$9)`,
          [
            principal.tenantId,
            requestedRef,
            principal.userId,
            asset.rows[0].id,
            input.method,
            input.destinationRef,
            input.amountAtoms,
            input.idempotencyKey,
            fingerprint,
          ],
        );
        return requestedRef;
      },
    );
    const row = await this.database.query<WithdrawalRow>(
      `select wr.withdrawal_ref, wr.method, a.symbol as asset, wr.amount_atoms::text,
        wr.fee_atoms::text, wr.status::text, null::text as provider_transaction_ref,
        wr.requested_at::text as created_at, null::text as completed_at
       from public.withdrawal_requests wr join public.assets a on a.id = wr.asset_id
       where wr.tenant_id = $1 and wr.withdrawal_ref = $2`,
      [principal.tenantId, withdrawalRef],
    );
    return mapWithdrawal(row.rows[0]!);
  }

  async confirmWithdrawal(
    principal: AuthPrincipal,
    withdrawalRef: string,
    input: { idempotencyKey: string },
  ): Promise<Withdrawal> {
    if (!principal.mfaVerified) {
      throw domainError('MFA_REQUIRED', 'MFA or passkey confirmation is required.', 403);
    }
    const request = await this.database.query<{
      status: string;
      method: CreateWithdrawal['method'];
      asset: string;
      amount_atoms: string;
      destination_ref: string;
      idempotency_key: string;
    }>(
      `select wr.status::text, wr.method, a.symbol as asset, wr.amount_atoms::text,
        wr.destination_ref, wr.idempotency_key
       from public.withdrawal_requests wr join public.assets a on a.id = wr.asset_id
       where wr.tenant_id = $1 and wr.user_id = $2 and wr.withdrawal_ref = $3`,
      [principal.tenantId, principal.userId, withdrawalRef],
    );
    const row = request.rows[0];
    if (!row) throw domainError('WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.', 404);
    if (row.status !== 'authentication_required') {
      const list = await this.withdrawals(principal);
      return list.find((value) => value.withdrawalRef === withdrawalRef)!;
    }
    const submission = await this.providers.createWithdrawal(withdrawalRef, principal.userRef, {
      method: row.method,
      asset: row.asset,
      amountAtoms: row.amount_atoms,
      destinationRef: row.destination_ref,
      idempotencyKey: `${row.idempotency_key}:${input.idempotencyKey}`,
    });
    await this.database.transaction({ tenantId: principal.tenantId }, async (client) => {
      const locked = await client.query<{ id: string }>(
        `select id from public.withdrawal_requests
         where tenant_id = $1 and withdrawal_ref = $2 and status = 'authentication_required'
         for update`,
        [principal.tenantId, withdrawalRef],
      );
      if (!locked.rows[0]) return;
      await client.query(`update public.withdrawal_requests set status = $1 where id = $2`, [
        submission.status,
        locked.rows[0].id,
      ]);
      await client.query(
        `insert into public.withdrawals
         (tenant_id, withdrawal_request_id, provider_ref, provider_transaction_ref, status, submitted_at)
         values ($1,$2,$3,$4,$5,clock_timestamp())
         on conflict (withdrawal_request_id) do nothing`,
        [
          principal.tenantId,
          locked.rows[0].id,
          submission.provider,
          submission.providerTransactionRef,
          submission.status,
        ],
      );
    });
    return (await this.withdrawals(principal)).find(
      (value) => value.withdrawalRef === withdrawalRef,
    )!;
  }

  async processPaymentEvent(event: VerifiedProviderEvent): Promise<{ duplicate: boolean }> {
    const payloadHash = sha256(JSON.stringify(event.raw));
    return this.database.transaction({}, async (client) => {
      const inserted = await client.query(
        `insert into public.payment_provider_events
         (provider_ref, provider_event_ref, event_type, payload_hash, payload, signature_valid)
         values ('configured-payment-provider',$1,$2,$3,$4,true)
         on conflict (provider_ref, provider_event_ref) do nothing returning id`,
        [event.providerEventRef, event.eventType, payloadHash, event.raw],
      );
      if (!inserted.rowCount) return { duplicate: true };
      if (event.eventType === 'deposit.credited') {
        await creditDeposit(client, event);
      } else if (event.eventType === 'withdrawal.completed') {
        await completeWithdrawal(client, event);
      } else if (event.eventType === 'withdrawal.failed') {
        await failWithdrawal(client, event);
      }
      await client.query(
        `update public.payment_provider_events set processed_at = clock_timestamp()
         where provider_ref = 'configured-payment-provider' and provider_event_ref = $1`,
        [event.providerEventRef],
      );
      return { duplicate: false };
    });
  }

  async createMarket(principal: AuthPrincipal, input: CreateMarket): Promise<Market> {
    const marketRef = externalRef('mkt');
    await this.database.transaction({ tenantId: principal.tenantId }, async (client) => {
      const refs = await client.query<{
        product_id: string;
        category_id: string;
        policy_id: string;
        fee_id: string;
        asset_id: string;
      }>(
        `select pd.id as product_id, c.id as category_id, jp.id as policy_id,
          fs.id as fee_id, a.id as asset_id
         from public.product_definitions pd
         cross join public.market_categories c
         cross join public.jurisdiction_policies jp
         cross join public.fee_schedules fs
         cross join public.assets a
         where pd.product_ref = $1 and pd.status = 'approved'
           and c.category_ref = $2 and c.enabled
           and jp.policy_ref = $3 and jp.status = 'active'
           and fs.tenant_id = $4 and fs.fee_schedule_ref = $5 and fs.status = 'active'
           and a.symbol = $6 and a.enabled
         order by pd.version desc, jp.version desc, fs.version desc limit 1`,
        [
          input.productRef,
          input.categoryRef,
          input.jurisdictionPolicyRef,
          principal.tenantId,
          input.feeScheduleRef,
          input.collateralAsset,
        ],
      );
      const ref = refs.rows[0];
      if (!ref)
        throw domainError(
          'MARKET_CONFIGURATION_INVALID',
          'Market configuration is incomplete.',
          409,
        );
      const inserted = await client.query<{ id: string }>(
        `insert into public.markets
         (tenant_id, market_ref, product_definition_id, category_id, jurisdiction_policy_id,
          fee_schedule_id, title, question, display_timezone, opens_at, closes_at,
          resolution_at, collateral_asset_id, payout_atoms, tick_atoms,
          minimum_order_quantity, maximum_position_quantity, risk_class,
          immutable_rule_version, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         returning id`,
        [
          principal.tenantId,
          marketRef,
          ref.product_id,
          ref.category_id,
          ref.policy_id,
          ref.fee_id,
          input.title,
          input.question,
          input.displayTimezone,
          input.opensAt,
          input.closesAt,
          input.resolutionAt,
          ref.asset_id,
          input.payoutAtoms,
          input.tickAtoms,
          input.minimumOrderQuantity,
          input.maximumPositionQuantity,
          input.riskClass,
          `rules-${new Date().toISOString()}`,
          principal.userId,
        ],
      );
      const marketId = inserted.rows[0]!.id;
      const ruleHash = sha256(input.rules);
      await client.query(
        `insert into public.market_rules
         (market_id, version, rules, tie_behavior, cancellation_behavior, void_behavior, content_hash)
         values ($1,1,$2,'void','cancel_open_orders','refund_collateral',$3)`,
        [marketId, input.rules, ruleHash],
      );
      await client.query(
        `insert into public.market_sources (market_id, source_type, source_uri, source_name, priority)
         values ($1,'primary',$2,'Primary resolution source',1)`,
        [marketId, input.primarySource],
      );
      if (input.backupSource) {
        await client.query(
          `insert into public.market_sources (market_id, source_type, source_uri, source_name, priority)
           values ($1,'backup',$2,'Backup resolution source',2)`,
          [marketId, input.backupSource],
        );
      }
      if (input.priceIndexRef) {
        const priceIndex = await client.query(
          `select 1 from public.price_indexes where index_ref = $1 and status = 'active'`,
          [input.priceIndexRef],
        );
        if (!priceIndex.rowCount) {
          throw domainError(
            'PRICE_INDEX_NOT_ACTIVE',
            'The selected price index is not active.',
            409,
          );
        }
        await client.query(
          `insert into public.market_sources
           (market_id,source_type,source_uri,source_name,priority)
           values ($1,'price_index',$2,'Approved price index',1)`,
          [marketId, input.priceIndexRef],
        );
      }
      for (const [index, outcome] of input.outcomes.entries()) {
        const outcomeRef = externalRef('out');
        const created = await client.query<{ id: string }>(
          `insert into public.market_outcomes
           (tenant_id, market_id, outcome_ref, label, display_order)
           values ($1,$2,$3,$4,$5) returning id`,
          [principal.tenantId, marketId, outcomeRef, outcome.label, index],
        );
        await client.query(
          `insert into public.market_book_sequences (market_id, outcome_id) values ($1,$2)`,
          [marketId, created.rows[0]!.id],
        );
      }
      await client.query(
        `insert into public.market_versions (market_id, version, snapshot, content_hash, created_by)
         values ($1,1,$2,$3,$4)`,
        [marketId, input, sha256(JSON.stringify(input)), principal.userId],
      );
      await audit(client, principal, 'market.create', 'market', marketRef, null, input);
    });
    return this.getMarket(marketRef, true);
  }

  async transitionMarket(
    principal: AuthPrincipal,
    marketRef: string,
    status: Market['status'],
    reason: string,
  ): Promise<Market> {
    await this.database.transaction({ tenantId: principal.tenantId }, async (client) => {
      await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
        principal.tenantId,
        marketRef,
        status,
        principal.userId,
        reason,
      ]);
      if (status === 'closing') {
        const openOrders = await client.query<{
          id: string;
          order_ref: string;
          user_id: string;
        }>(
          `select o.id, o.order_ref, o.user_id from public.orders o
           join public.markets m on m.id = o.market_id
           where m.tenant_id = $1 and m.market_ref = $2
             and o.status in ('open','partially_filled')
           order by o.book_sequence for update of o`,
          [principal.tenantId, marketRef],
        );
        for (const order of openOrders.rows) {
          await cancelRemainder(
            client,
            { tenantId: principal.tenantId, userId: order.user_id },
            order.id,
            order.order_ref,
          );
        }
        await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
          principal.tenantId,
          marketRef,
          'closed',
          principal.userId,
          'All remaining orders were cancelled and reservations were released.',
        ]);
        await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
          principal.tenantId,
          marketRef,
          'resolution_pending',
          principal.userId,
          'The market is ready for resolution evidence.',
        ]);
      }
      await audit(client, principal, 'market.transition', 'market', marketRef, null, {
        status: status === 'closing' ? 'resolution_pending' : status,
        reason,
      });
    });
    return this.getMarket(marketRef, true);
  }

  async proposeResolution(
    principal: AuthPrincipal,
    marketRef: string,
    input: ProposeResolution,
  ): Promise<{ proposalRef: string }> {
    const proposalRef = externalRef('rsp');
    await this.database.transaction({ tenantId: principal.tenantId }, async (client) => {
      const market = await client.query<{ id: string; outcome_id: string }>(
        `select m.id, mo.id as outcome_id from public.markets m
         join public.market_outcomes mo on mo.market_id = m.id and mo.outcome_ref = $2
         where m.tenant_id = $3 and m.market_ref = $1
           and m.status in ('resolution_pending','disputed') for update of m`,
        [marketRef, input.outcomeRef, principal.tenantId],
      );
      if (!market.rows[0]) {
        throw domainError(
          'MARKET_NOT_RESOLUTION_READY',
          'Market is not ready for resolution.',
          409,
        );
      }
      const evidenceHash = sha256(JSON.stringify(input.evidence));
      const inserted = await client.query<{ id: string }>(
        `insert into public.resolution_proposals
         (tenant_id, proposal_ref, market_id, outcome_id, proposed_by, reason,
          evidence_hash, result)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          principal.tenantId,
          proposalRef,
          market.rows[0].id,
          market.rows[0].outcome_id,
          principal.userId,
          input.reason,
          evidenceHash,
          input.outcomeRef,
        ],
      );
      for (const evidence of input.evidence) {
        await client.query(
          `insert into public.resolution_evidence
           (proposal_id, source_uri, content_hash, captured_at, notes)
           values ($1,$2,$3,$4,$5)`,
          [
            inserted.rows[0]!.id,
            evidence.source,
            evidence.contentHash,
            evidence.capturedAt,
            evidence.notes,
          ],
        );
      }
      await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
        principal.tenantId,
        marketRef,
        'proposed',
        principal.userId,
        'Resolution proposed with retained evidence.',
      ]);
      await audit(client, principal, 'resolution.propose', 'market', marketRef, null, {
        proposalRef,
        evidenceHash,
      });
    });
    return { proposalRef };
  }

  async approveResolution(
    principal: AuthPrincipal,
    proposalRef: string,
    reason: string,
  ): Promise<{ market: Market; proposalRef: string }> {
    let marketRef = '';
    await this.database.transaction({ tenantId: principal.tenantId }, async (client) => {
      const proposal = await client.query<{
        id: string;
        market_id: string;
        market_ref: string;
        proposed_by: string;
        status: string;
      }>(
        `select rp.id, rp.market_id, m.market_ref, rp.proposed_by, rp.status
         from public.resolution_proposals rp join public.markets m on m.id = rp.market_id
         where rp.tenant_id = $1 and rp.proposal_ref = $2 for update`,
        [principal.tenantId, proposalRef],
      );
      const row = proposal.rows[0];
      if (!row) throw domainError('RESOLUTION_NOT_FOUND', 'Resolution proposal not found.', 404);
      marketRef = row.market_ref;
      if (row.status === 'approved') return;
      if (row.status !== 'proposed') {
        throw domainError('RESOLUTION_NOT_OPEN', 'Resolution proposal is not open.', 409);
      }
      if (row.proposed_by === principal.userId) {
        throw domainError(
          'INDEPENDENT_APPROVER_REQUIRED',
          'A different officer must approve.',
          409,
        );
      }
      await client.query(
        `insert into public.resolution_approvals (proposal_id, officer_id, decision, reason)
         values ($1,$2,'approve',$3)`,
        [row.id, principal.userId, reason],
      );
      await client.query(
        `update public.resolution_proposals set status = 'approved',
          approved_at = clock_timestamp() where id = $1`,
        [row.id],
      );
      await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
        principal.tenantId,
        marketRef,
        'resolved',
        principal.userId,
        reason,
      ]);
      await audit(client, principal, 'resolution.approve', 'resolution', proposalRef, null, {
        reason,
      });
    });
    return { market: await this.getMarket(marketRef, true), proposalRef };
  }

  async operationsOverview(principal: AuthPrincipal) {
    const result = await this.database.query<{
      open_markets: string;
      pending_resolutions: string;
      pending_withdrawals: string;
      open_compliance_cases: string;
      ledger_difference_count: string;
      critical_reconciliation_cases: string;
    }>(
      `select
        (select count(*) from public.markets where tenant_id = $1 and status = 'open')::text as open_markets,
        (select count(*) from public.markets where tenant_id = $1 and status in ('resolution_pending','proposed','disputed'))::text as pending_resolutions,
        (select count(*) from public.withdrawal_requests where tenant_id = $1 and status not in ('completed','rejected','cancelled','failed','reversed'))::text as pending_withdrawals,
        (select count(*) from public.aml_cases where tenant_id = $1 and status <> 'closed')::text as open_compliance_cases,
        (select count(*) from (
          select journal_id from public.ledger_entries le
          join public.ledger_journals lj on lj.id = le.journal_id
          where lj.tenant_id = $1 group by journal_id
          having sum(debit_atoms) <> sum(credit_atoms)
        ) x)::text as ledger_difference_count,
        (select count(*) from public.reconciliation_cases rc
          join public.reconciliation_items ri on ri.id = rc.reconciliation_item_id
          join public.reconciliation_runs rr on rr.id = ri.reconciliation_run_id
          where rr.tenant_id = $1 and rc.status <> 'resolved'
            and (rc.blocks_withdrawals or rc.blocks_settlement or rc.blocks_publication))::text
          as critical_reconciliation_cases`,
      [principal.tenantId],
    );
    return result.rows[0]!;
  }

  async operationsRecords(
    principal: AuthPrincipal,
    resource:
      | 'deposits'
      | 'withdrawals'
      | 'compliance'
      | 'reconciliation'
      | 'audit'
      | 'price_feeds'
      | 'ledger'
      | 'resolutions',
  ): Promise<QueryResultRow[]> {
    const statements: Record<typeof resource, string> = {
      deposits: `select d.deposit_ref, u.user_ref, a.symbol as asset,
        d.amount_atoms::text, d.fee_atoms::text, d.status::text,
        d.provider_ref, d.provider_transaction_ref, d.created_at::text
        from public.deposits d join public.users u on u.id = d.user_id
        join public.assets a on a.id = d.asset_id
        where d.tenant_id = $1 order by d.created_at desc limit 500`,
      withdrawals: `select wr.withdrawal_ref, u.user_ref, a.symbol as asset,
        wr.amount_atoms::text, wr.fee_atoms::text,
        coalesce(w.status,wr.status)::text as status, w.provider_ref,
        w.provider_transaction_ref, wr.requested_at::text
        from public.withdrawal_requests wr join public.users u on u.id = wr.user_id
        join public.assets a on a.id = wr.asset_id
        left join public.withdrawals w on w.withdrawal_request_id = wr.id
        where wr.tenant_id = $1 order by wr.requested_at desc limit 500`,
      compliance: `select ac.case_ref, u.user_ref, ac.status, ac.risk_level,
        ac.opened_at::text, ac.closed_at::text
        from public.aml_cases ac join public.users u on u.id = ac.user_id
        where ac.tenant_id = $1 order by ac.opened_at desc limit 500`,
      reconciliation: `select rr.run_ref, rr.scope, rr.status,
        ri.provider_ref, a.symbol as asset, ri.expected_atoms::text,
        ri.actual_atoms::text, ri.difference_atoms::text, ri.severity, ri.state
        from public.reconciliation_runs rr
        join public.reconciliation_items ri on ri.reconciliation_run_id = rr.id
        join public.assets a on a.id = ri.asset_id
        where rr.tenant_id = $1 order by rr.started_at desc limit 500`,
      audit: `select event_ref, actor_ref, actor_roles, action, resource_type,
        resource_ref, occurred_at::text from public.audit_log
        where tenant_id = $1 order by occurred_at desc limit 1000`,
      price_feeds: `select pp.provider_ref, pi.normalized_symbol,
        pfh.status::text, pfh.last_observation_at::text,
        pfh.delay_milliseconds::text, pfh.consecutive_failures, pfh.reason,
        pfh.updated_at::text
        from public.price_feed_health pfh
        join public.price_providers pp on pp.id = pfh.provider_id
        join public.price_instruments pi on pi.id = pfh.instrument_id
        order by pi.normalized_symbol, pp.provider_ref`,
      ledger: `select lj.journal_ref, lj.transaction_type, a.symbol as asset,
        lj.reference_type, lj.reference_ref, lj.status, lj.effective_at::text,
        sum(le.debit_atoms)::text as debit_atoms,
        sum(le.credit_atoms)::text as credit_atoms
        from public.ledger_journals lj join public.assets a on a.id = lj.asset_id
        join public.ledger_entries le on le.journal_id = lj.id
        where lj.tenant_id = $1 group by lj.id,a.symbol
        order by lj.effective_at desc limit 1000`,
      resolutions: `select rp.proposal_ref,m.market_ref,m.title,mo.label as outcome,
        rp.status,rp.result,rp.proposed_at::text,rp.approved_at::text,
        proposer.user_ref as proposed_by
        from public.resolution_proposals rp
        join public.markets m on m.id = rp.market_id
        left join public.market_outcomes mo on mo.id = rp.outcome_id
        join public.users proposer on proposer.id = rp.proposed_by
        where rp.tenant_id = $1 order by rp.proposed_at desc limit 500`,
    };
    const result = await this.database.query(statements[resource], [principal.tenantId]);
    return result.rows;
  }
}

interface MarketRow extends QueryResultRow {
  market_ref: string;
  tenant_ref: string;
  product_type: Market['productType'];
  title: string;
  question: string;
  category: string;
  image_url: string | null;
  rules: string;
  resolution_source: string;
  backup_resolution_source: string | null;
  resolution_time: string;
  opens_at: string;
  closes_at: string;
  display_timezone: string;
  status: Market['status'];
  trading_suspended: boolean;
  collateral_asset: string;
  asset_decimals: number;
  payout_atoms: string;
  tick_atoms: string;
  minimum_order_quantity: string;
  maximum_position_quantity: string;
  fee_version: string;
  immutable_rule_version: string;
  featured: boolean;
  volume_atoms: string;
  liquidity_atoms: string;
  open_interest_atoms: string;
  change_24h_basis_points: number | null;
  outcomes: Array<{
    outcomeRef: string;
    label: string;
    displayOrder: number;
    lastPriceAtoms: string | null;
  }>;
}

function marketSelect(): string {
  return `select m.market_ref, t.tenant_ref, pd.product_type, m.title, m.question,
    c.name as category, m.image_url, mr.rules,
    src.source_uri as resolution_source, backup.source_uri as backup_resolution_source,
    m.resolution_at::text as resolution_time, m.opens_at::text, m.closes_at::text,
    m.display_timezone, m.status::text, m.trading_suspended, a.symbol as collateral_asset,
    a.decimals as asset_decimals, m.payout_atoms::text, m.tick_atoms::text,
    m.minimum_order_quantity::text, m.maximum_position_quantity::text,
    fs.fee_schedule_ref || ':' || fs.version as fee_version, m.immutable_rule_version,
    m.featured, coalesce(s.volume_atoms, 0)::text as volume_atoms,
    coalesce(s.liquidity_atoms, 0)::text as liquidity_atoms,
    coalesce(s.open_interest_atoms, 0)::text as open_interest_atoms,
    case when day_price.price_atoms > 0 and current_price.price_atoms is not null
      then (((current_price.price_atoms - day_price.price_atoms) * 10000) / day_price.price_atoms)::int
      else null end as change_24h_basis_points,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'outcomeRef', mo.outcome_ref, 'label', mo.label, 'displayOrder', mo.display_order,
        'lastPriceAtoms', mps.last_price_atoms::text
      ) order by mo.display_order)
      from public.market_outcomes mo
      left join public.market_price_snapshots mps on mps.market_id = mo.market_id and mps.outcome_id = mo.id
      where mo.market_id = m.id
    ), '[]'::jsonb) as outcomes
   from public.markets m
   join public.tenants t on t.id = m.tenant_id
   join public.product_definitions pd on pd.id = m.product_definition_id
   join public.market_categories c on c.id = m.category_id
   join public.assets a on a.id = m.collateral_asset_id
   join public.fee_schedules fs on fs.id = m.fee_schedule_id
   join lateral (
     select rules from public.market_rules where market_id = m.id order by version desc limit 1
   ) mr on true
   join lateral (
     select source_uri from public.market_sources
     where market_id = m.id and source_type = 'primary' order by priority limit 1
   ) src on true
   left join lateral (
     select source_uri from public.market_sources
     where market_id = m.id and source_type = 'backup' order by priority limit 1
   ) backup on true
   left join lateral (
     select sum(volume_atoms) as volume_atoms, sum(liquidity_atoms) as liquidity_atoms,
       sum(open_interest_atoms) as open_interest_atoms
     from public.market_price_snapshots where market_id = m.id
   ) s on true
   left join lateral (
     select price_atoms from public.market_price_history
     where market_id = m.id order by observed_at desc limit 1
   ) current_price on true
   left join lateral (
     select price_atoms from public.market_price_history
     where market_id = m.id and observed_at <= clock_timestamp() - interval '24 hours'
     order by observed_at desc limit 1
   ) day_price on true`;
}

function mapMarket(row: MarketRow): Market {
  return {
    marketRef: row.market_ref,
    tenantRef: row.tenant_ref,
    productType: row.product_type,
    title: row.title,
    question: row.question,
    category: row.category,
    imageUrl: row.image_url,
    rules: row.rules,
    resolutionSource: row.resolution_source,
    backupResolutionSource: row.backup_resolution_source,
    resolutionTime: new Date(row.resolution_time).toISOString(),
    opensAt: new Date(row.opens_at).toISOString(),
    closesAt: new Date(row.closes_at).toISOString(),
    displayTimezone: row.display_timezone,
    status: row.status,
    tradingSuspended: row.trading_suspended,
    collateralAsset: row.collateral_asset,
    assetDecimals: row.asset_decimals,
    payoutAtoms: row.payout_atoms,
    tickAtoms: row.tick_atoms,
    minimumOrderQuantity: row.minimum_order_quantity,
    maximumPositionQuantity: row.maximum_position_quantity,
    feeVersion: row.fee_version,
    immutableRuleVersion: row.immutable_rule_version,
    featured: row.featured,
    volumeAtoms: row.volume_atoms,
    liquidityAtoms: row.liquidity_atoms,
    openInterestAtoms: row.open_interest_atoms,
    change24hBasisPoints: row.change_24h_basis_points,
    outcomes: row.outcomes,
  };
}

interface OrderRow extends QueryResultRow {
  order_ref: string;
  market_ref: string;
  outcome_ref: string;
  side: Order['side'];
  price_atoms: string;
  quantity: string;
  remaining_quantity: string;
  time_in_force: Order['timeInForce'];
  post_only: boolean;
  status: Order['status'];
  idempotency_key: string;
  request_fingerprint: string;
  book_sequence: string;
  created_at: string;
  updated_at: string;
  quote_ref: string;
}

function orderSelect(): string {
  return `select o.order_ref, m.market_ref, mo.outcome_ref, o.side::text,
    o.price_atoms::text, o.quantity::text, o.remaining_quantity::text,
    o.time_in_force::text, o.post_only, o.status::text, o.idempotency_key,
    o.request_fingerprint, o.book_sequence::text, o.created_at::text, o.updated_at::text,
    coalesce(fq.quote_ref, 'consumed') as quote_ref
   from public.orders o
   join public.markets m on m.id = o.market_id
   join public.market_outcomes mo on mo.id = o.outcome_id
   left join lateral (
     select quote_ref from public.fee_quotes
     where user_id = o.user_id and market_id = o.market_id and outcome_id = o.outcome_id
       and consumed_at is not null
     order by consumed_at desc limit 1
   ) fq on true`;
}

function mapOrder(row: OrderRow): Order {
  return {
    orderRef: row.order_ref,
    marketRef: row.market_ref,
    outcomeRef: row.outcome_ref,
    side: row.side,
    type: 'limit',
    priceAtoms: row.price_atoms,
    quantity: row.quantity,
    remainingQuantity: row.remaining_quantity,
    timeInForce: row.time_in_force,
    postOnly: row.post_only,
    maximumSlippageBasisPoints: 0,
    quoteRef: row.quote_ref,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    sequence: row.book_sequence,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

interface TradeRow extends QueryResultRow {
  trade_ref: string;
  market_ref: string;
  outcome_ref: string;
  maker_order_ref: string;
  taker_order_ref: string;
  price_atoms: string;
  quantity: string;
  buyer_fee_atoms: string;
  seller_fee_atoms: string;
  book_sequence: string;
  executed_at: string;
}

function mapTrade(row: TradeRow): Trade {
  return {
    tradeRef: row.trade_ref,
    marketRef: row.market_ref,
    outcomeRef: row.outcome_ref,
    makerOrderRef: row.maker_order_ref,
    takerOrderRef: row.taker_order_ref,
    priceAtoms: row.price_atoms,
    quantity: row.quantity,
    buyerFeeAtoms: row.buyer_fee_atoms,
    sellerFeeAtoms: row.seller_fee_atoms,
    sequence: row.book_sequence,
    executedAt: new Date(row.executed_at).toISOString(),
  };
}

interface DepositRow extends QueryResultRow {
  deposit_ref: string;
  method: string;
  asset: string;
  amount_atoms: string;
  fee_atoms: string;
  status: Deposit['status'];
  provider_transaction_ref: string | null;
  created_at: string;
  completed_at: string | null;
}
function mapDeposit(row: DepositRow): Deposit {
  return {
    depositRef: row.deposit_ref,
    method: row.method,
    asset: row.asset,
    amountAtoms: row.amount_atoms,
    feeAtoms: row.fee_atoms,
    status: row.status,
    providerReference: row.provider_transaction_ref,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

interface WithdrawalRow extends QueryResultRow {
  withdrawal_ref: string;
  method: string;
  asset: string;
  amount_atoms: string;
  fee_atoms: string;
  status: Withdrawal['status'];
  provider_transaction_ref: string | null;
  created_at: string;
  completed_at: string | null;
}
function mapWithdrawal(row: WithdrawalRow): Withdrawal {
  return {
    withdrawalRef: row.withdrawal_ref,
    method: row.method,
    asset: row.asset,
    amountAtoms: row.amount_atoms,
    feeAtoms: row.fee_atoms,
    status: row.status,
    providerReference: row.provider_transaction_ref,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

interface MatchInput {
  tenantId: string;
  orderId: string;
  orderRef: string;
  userId: string;
  marketId: string;
  outcomeId: string;
  assetId: string;
  side: 'buy' | 'sell';
  priceAtoms: bigint;
  quantity: bigint;
  feeScheduleId: string;
  feeScheduleVersion: number;
}

async function matchOrder(client: SqlClient, input: MatchInput): Promise<void> {
  const fee = await client.query<{ maker_basis_points: number; taker_basis_points: number }>(
    `select coalesce(maker_basis_points,0) as maker_basis_points,
      coalesce(taker_basis_points,0) as taker_basis_points
     from public.fee_rules where fee_schedule_id = $1 and fee_type = 'trading'
     order by market_ref nulls last limit 1`,
    [input.feeScheduleId],
  );
  const makerBps = BigInt(fee.rows[0]?.maker_basis_points ?? 0);
  const takerBps = BigInt(fee.rows[0]?.taker_basis_points ?? 0);
  let remaining = input.quantity;
  const makers = await client.query<{
    id: string;
    order_ref: string;
    user_id: string;
    side: 'buy' | 'sell';
    price_atoms: string;
    remaining_quantity: string;
  }>(
    `select id, order_ref, user_id, side::text, price_atoms::text, remaining_quantity::text
     from public.orders
     where market_id = $1 and outcome_id = $2 and side = $3
       and status in ('open','partially_filled')
       and case when $4 = 'buy' then price_atoms <= $5 else price_atoms >= $5 end
       and id <> $6
     order by case when side = 'sell' then price_atoms end asc,
              case when side = 'buy' then price_atoms end desc,
              book_sequence asc
     for update`,
    [
      input.marketId,
      input.outcomeId,
      input.side === 'buy' ? 'sell' : 'buy',
      input.side,
      input.priceAtoms.toString(),
      input.orderId,
    ],
  );
  for (const maker of makers.rows) {
    if (remaining === 0n) break;
    const makerRemaining = BigInt(maker.remaining_quantity);
    const quantity = remaining < makerRemaining ? remaining : makerRemaining;
    const price = BigInt(maker.price_atoms);
    const gross = price * quantity;
    const makerFee = basisPointsCeil(gross, makerBps);
    const takerFee = basisPointsCeil(gross, takerBps);
    const buyerUserId = input.side === 'buy' ? input.userId : maker.user_id;
    const sellerUserId = input.side === 'sell' ? input.userId : maker.user_id;
    const buyerFee = input.side === 'buy' ? takerFee : makerFee;
    const sellerFee = input.side === 'sell' ? takerFee : makerFee;
    const tradeRef = externalRef('trd');
    const sequence = await nextBookSequence(client, input.marketId, input.outcomeId);
    const journalId = await postTradeJournal(client, {
      tenantId: input.tenantId,
      assetId: input.assetId,
      buyerUserId,
      sellerUserId,
      gross,
      buyerFee,
      sellerFee,
      tradeRef,
    });
    const trade = await client.query<{ id: string }>(
      `insert into public.trades
       (tenant_id, trade_ref, market_id, outcome_id, maker_order_id, taker_order_id,
        buyer_user_id, seller_user_id, price_atoms, quantity, buyer_fee_atoms,
        seller_fee_atoms, book_sequence, ledger_journal_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [
        input.tenantId,
        tradeRef,
        input.marketId,
        input.outcomeId,
        maker.id,
        input.orderId,
        buyerUserId,
        sellerUserId,
        price.toString(),
        quantity.toString(),
        buyerFee.toString(),
        sellerFee.toString(),
        sequence,
        journalId,
      ],
    );
    await client.query(
      `update public.orders set remaining_quantity = remaining_quantity - $2,
        actual_fee_atoms = actual_fee_atoms + $3,
        status = case when remaining_quantity - $2 = 0 then 'filled'::public.order_status
          else 'partially_filled'::public.order_status end,
        updated_at = clock_timestamp()
       where id = $1`,
      [maker.id, quantity.toString(), makerFee.toString()],
    );
    remaining -= quantity;
    await client.query(
      `update public.orders set remaining_quantity = $2,
        actual_fee_atoms = actual_fee_atoms + $3,
        status = case when $2 = 0 then 'filled'::public.order_status
          else 'partially_filled'::public.order_status end,
        updated_at = clock_timestamp()
       where id = $1`,
      [input.orderId, remaining.toString(), takerFee.toString()],
    );
    await client.query(
      `update public.collateral_reservations set
        amount_atoms = greatest(0, amount_atoms - $2),
        quantity = greatest(0, quantity - $3)
       where order_id = $1`,
      [
        input.orderId,
        input.side === 'buy' ? (gross + buyerFee).toString() : '0',
        input.side === 'sell' ? quantity.toString() : '0',
      ],
    );
    await client.query(
      `update public.collateral_reservations set
        amount_atoms = greatest(0, amount_atoms - $2),
        quantity = greatest(0, quantity - $3)
       where order_id = $1`,
      [
        maker.id,
        maker.side === 'buy' ? (gross + buyerFee).toString() : '0',
        maker.side === 'sell' ? quantity.toString() : '0',
      ],
    );
    await client.query(
      `insert into public.positions
       (tenant_id, user_id, market_id, outcome_id, available_quantity,
        locked_quantity, cost_atoms, fees_paid_atoms)
       values ($1,$2,$3,$4,$5,0,$6,$7)
       on conflict (user_id, market_id, outcome_id)
       do update set available_quantity = public.positions.available_quantity + excluded.available_quantity,
         cost_atoms = public.positions.cost_atoms + excluded.cost_atoms,
         fees_paid_atoms = public.positions.fees_paid_atoms + excluded.fees_paid_atoms,
         updated_at = clock_timestamp()`,
      [
        input.tenantId,
        buyerUserId,
        input.marketId,
        input.outcomeId,
        quantity.toString(),
        gross.toString(),
        buyerFee.toString(),
      ],
    );
    const soldCostAtoms = await consumePositionCost(
      client,
      sellerUserId,
      input.marketId,
      input.outcomeId,
      quantity,
    );
    await client.query(
      `update public.positions set locked_quantity = locked_quantity - $2,
        cost_atoms = cost_atoms - $7,
        fees_paid_atoms = fees_paid_atoms + $3,
        realized_pnl_atoms = realized_pnl_atoms + $4,
        updated_at = clock_timestamp()
       where user_id = $1 and market_id = $5 and outcome_id = $6`,
      [
        sellerUserId,
        quantity.toString(),
        sellerFee.toString(),
        (gross - sellerFee - soldCostAtoms).toString(),
        input.marketId,
        input.outcomeId,
        soldCostAtoms.toString(),
      ],
    );
    await client.query(
      `insert into public.position_lots (position_id, trade_id, quantity, remaining_quantity, cost_atoms)
       select id, $2, $3, $3, $4 from public.positions
       where user_id = $1 and market_id = $5 and outcome_id = $6`,
      [
        buyerUserId,
        trade.rows[0]!.id,
        quantity.toString(),
        gross.toString(),
        input.marketId,
        input.outcomeId,
      ],
    );
    await client.query(
      `insert into public.market_price_history
       (market_id, outcome_id, price_atoms, volume_atoms, source, observed_at)
       values ($1,$2,$3,$4,'trade',clock_timestamp())`,
      [input.marketId, input.outcomeId, price.toString(), gross.toString()],
    );
    await client.query(
      `insert into public.market_price_snapshots
       (market_id, outcome_id, last_price_atoms, volume_atoms, open_interest_atoms, book_sequence)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (market_id,outcome_id) do update
       set last_price_atoms = excluded.last_price_atoms,
         volume_atoms = public.market_price_snapshots.volume_atoms + excluded.volume_atoms,
         open_interest_atoms = public.market_price_snapshots.open_interest_atoms + excluded.open_interest_atoms,
         book_sequence = excluded.book_sequence, updated_at = clock_timestamp()`,
      [
        input.marketId,
        input.outcomeId,
        price.toString(),
        gross.toString(),
        quantity.toString(),
        sequence,
      ],
    );
    await reconcileReservation(client, input.tenantId, maker.id);
  }
}

async function reserveFunds(
  client: SqlClient,
  principal: AuthPrincipal,
  assetId: string,
  amount: bigint,
  orderRef: string,
): Promise<void> {
  const available = await ledgerAccount(
    client,
    principal.tenantId,
    principal.userId,
    assetId,
    'customer_available',
  );
  const locked = await ledgerAccount(
    client,
    principal.tenantId,
    principal.userId,
    assetId,
    'customer_locked',
  );
  if (!available || !locked || available.balance < amount) {
    throw domainError(
      'INSUFFICIENT_AVAILABLE_BALANCE',
      'Your available balance is insufficient.',
      409,
    );
  }
  await postJournal(client, {
    tenantId: principal.tenantId,
    assetId,
    transactionType: 'order_reservation',
    referenceType: 'order',
    referenceRef: orderRef,
    idempotencyKey: `order-reserve:${orderRef}`,
    postings: [
      { accountRef: available.accountRef, accountId: available.id, debitAtoms: amount },
      { accountRef: locked.accountRef, accountId: locked.id, creditAtoms: amount },
    ],
  });
}

async function consumePositionCost(
  client: SqlClient,
  userId: string,
  marketId: string,
  outcomeId: string,
  quantity: bigint,
): Promise<bigint> {
  const lots = await client.query<{
    id: string;
    remaining_quantity: string;
    cost_atoms: string;
  }>(
    `select pl.id, pl.remaining_quantity::text, pl.cost_atoms::text
     from public.position_lots pl
     join public.positions p on p.id = pl.position_id
     join public.trades t on t.id = pl.trade_id
     where p.user_id = $1 and p.market_id = $2 and p.outcome_id = $3
       and pl.remaining_quantity > 0
     order by t.executed_at, pl.id for update of pl`,
    [userId, marketId, outcomeId],
  );
  let remaining = quantity;
  let consumedCost = 0n;
  for (const lot of lots.rows) {
    if (remaining === 0n) break;
    const lotQuantity = BigInt(lot.remaining_quantity);
    const lotCost = BigInt(lot.cost_atoms);
    const take = remaining < lotQuantity ? remaining : lotQuantity;
    const cost = take === lotQuantity ? lotCost : (lotCost * take) / lotQuantity;
    await client.query(
      `update public.position_lots
       set remaining_quantity = remaining_quantity - $2, cost_atoms = cost_atoms - $3
       where id = $1`,
      [lot.id, take.toString(), cost.toString()],
    );
    remaining -= take;
    consumedCost += cost;
  }
  if (remaining !== 0n) {
    throw domainError('POSITION_LOT_MISMATCH', 'Position lot records are incomplete.', 409);
  }
  return consumedCost;
}

async function reservePosition(
  client: SqlClient,
  principal: AuthPrincipal,
  marketId: string,
  outcomeId: string,
  quantity: bigint,
): Promise<void> {
  const result = await client.query<{ id: string; available_quantity: string }>(
    `select id, available_quantity::text from public.positions
     where tenant_id = $1 and user_id = $2 and market_id = $3 and outcome_id = $4 for update`,
    [principal.tenantId, principal.userId, marketId, outcomeId],
  );
  const row = result.rows[0];
  if (!row || BigInt(row.available_quantity) < quantity) {
    throw domainError('INSUFFICIENT_POSITION', 'Available position quantity is insufficient.', 409);
  }
  await client.query(
    `update public.positions set available_quantity = available_quantity - $2,
      locked_quantity = locked_quantity + $2, updated_at = clock_timestamp() where id = $1`,
    [row.id, quantity.toString()],
  );
}

async function reserveWithdrawal(
  client: SqlClient,
  principal: AuthPrincipal,
  assetId: string,
  amount: bigint,
  withdrawalRef: string,
): Promise<void> {
  const available = await ledgerAccount(
    client,
    principal.tenantId,
    principal.userId,
    assetId,
    'customer_available',
  );
  const pending = await ledgerAccount(
    client,
    principal.tenantId,
    principal.userId,
    assetId,
    'customer_pending_withdrawal',
  );
  if (!available || !pending || available.balance < amount) {
    throw domainError(
      'INSUFFICIENT_AVAILABLE_BALANCE',
      'Your available balance is insufficient.',
      409,
    );
  }
  await postJournal(client, {
    tenantId: principal.tenantId,
    assetId,
    transactionType: 'withdrawal_reservation',
    referenceType: 'withdrawal',
    referenceRef: withdrawalRef,
    idempotencyKey: `withdrawal-reserve:${withdrawalRef}`,
    postings: [
      { accountRef: available.accountRef, accountId: available.id, debitAtoms: amount },
      { accountRef: pending.accountRef, accountId: pending.id, creditAtoms: amount },
    ],
  });
}

async function reconcileReservation(
  client: SqlClient,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const result = await client.query<{
    side: 'buy' | 'sell';
    order_ref: string;
    user_id: string;
    asset_id: string;
    remaining_quantity: string;
    price_atoms: string;
    amount_atoms: string;
    quantity: string;
    taker_basis_points: number;
  }>(
    `select o.side::text, o.order_ref, o.user_id, cr.asset_id,
      o.remaining_quantity::text, o.price_atoms::text, cr.amount_atoms::text,
      cr.quantity::text, coalesce(fr.taker_basis_points,0) as taker_basis_points
     from public.orders o join public.collateral_reservations cr on cr.order_id = o.id
     left join lateral (
       select taker_basis_points from public.fee_rules where fee_schedule_id = o.fee_schedule_id
       and fee_type = 'trading' order by market_ref nulls last limit 1
     ) fr on true where o.id = $1 for update of cr`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.side === 'buy') {
    const remaining = BigInt(row.remaining_quantity);
    const value = BigInt(row.price_atoms) * remaining;
    const required = value + basisPointsCeil(value, BigInt(row.taker_basis_points));
    const held = BigInt(row.amount_atoms);
    if (held > required) {
      const release = held - required;
      const locked = await ledgerAccount(
        client,
        tenantId,
        row.user_id,
        row.asset_id,
        'customer_locked',
      );
      const available = await ledgerAccount(
        client,
        tenantId,
        row.user_id,
        row.asset_id,
        'customer_available',
      );
      if (!locked || !available) throw new Error('Ledger accounts are incomplete.');
      await postJournal(client, {
        tenantId,
        assetId: row.asset_id,
        transactionType: 'order_reservation_release',
        referenceType: 'order',
        referenceRef: row.order_ref,
        idempotencyKey: `order-release:${row.order_ref}:${release}`,
        postings: [
          { accountRef: locked.accountRef, accountId: locked.id, debitAtoms: release },
          { accountRef: available.accountRef, accountId: available.id, creditAtoms: release },
        ],
      });
      await client.query(
        `update public.collateral_reservations set amount_atoms = $2,
          status = case when $2 = 0 then 'released' else status end,
          released_at = case when $2 = 0 then clock_timestamp() else released_at end
         where order_id = $1`,
        [orderId, required.toString()],
      );
    }
  }
}

async function cancelRemainder(
  client: SqlClient,
  principal: Pick<AuthPrincipal, 'tenantId' | 'userId'>,
  orderId: string,
  orderRef: string,
): Promise<void> {
  const result = await client.query<{
    status: string;
    side: 'buy' | 'sell';
    market_id: string;
    outcome_id: string;
    remaining_quantity: string;
    asset_id: string;
    amount_atoms: string;
    quantity: string;
  }>(
    `select o.status::text, o.side::text, o.market_id, o.outcome_id,
      o.remaining_quantity::text, cr.asset_id, cr.amount_atoms::text, cr.quantity::text
     from public.orders o join public.collateral_reservations cr on cr.order_id = o.id
     where o.id = $1 and o.user_id = $2 for update`,
    [orderId, principal.userId],
  );
  const row = result.rows[0];
  if (!row || !['open', 'partially_filled'].includes(row.status)) return;
  if (row.side === 'buy' && BigInt(row.amount_atoms) > 0n) {
    const locked = await ledgerAccount(
      client,
      principal.tenantId,
      principal.userId,
      row.asset_id,
      'customer_locked',
    );
    const available = await ledgerAccount(
      client,
      principal.tenantId,
      principal.userId,
      row.asset_id,
      'customer_available',
    );
    if (!locked || !available) throw new Error('Ledger accounts are incomplete.');
    const release = BigInt(row.amount_atoms);
    await postJournal(client, {
      tenantId: principal.tenantId,
      assetId: row.asset_id,
      transactionType: 'order_reservation_release',
      referenceType: 'order',
      referenceRef: orderRef,
      idempotencyKey: `order-cancel-release:${orderRef}`,
      postings: [
        { accountRef: locked.accountRef, accountId: locked.id, debitAtoms: release },
        { accountRef: available.accountRef, accountId: available.id, creditAtoms: release },
      ],
    });
  }
  if (row.side === 'sell' && BigInt(row.quantity) > 0n) {
    await client.query(
      `update public.positions set available_quantity = available_quantity + $4,
        locked_quantity = locked_quantity - $4, updated_at = clock_timestamp()
       where tenant_id = $1 and user_id = $2 and market_id = $3 and outcome_id = $5`,
      [principal.tenantId, principal.userId, row.market_id, row.quantity, row.outcome_id],
    );
  }
  await client.query(
    `update public.orders set remaining_quantity = 0, status = 'cancelled',
      updated_at = clock_timestamp() where id = $1`,
    [orderId],
  );
  await client.query(
    `update public.collateral_reservations set amount_atoms = 0, quantity = 0,
      status = 'released', released_at = clock_timestamp() where order_id = $1`,
    [orderId],
  );
}

async function postTradeJournal(
  client: SqlClient,
  input: {
    tenantId: string;
    assetId: string;
    buyerUserId: string;
    sellerUserId: string;
    gross: bigint;
    buyerFee: bigint;
    sellerFee: bigint;
    tradeRef: string;
  },
): Promise<string> {
  const buyerLocked = await ledgerAccount(
    client,
    input.tenantId,
    input.buyerUserId,
    input.assetId,
    'customer_locked',
  );
  const sellerAvailable = await ledgerAccount(
    client,
    input.tenantId,
    input.sellerUserId,
    input.assetId,
    'customer_available',
  );
  const fees = await ledgerAccount(
    client,
    input.tenantId,
    null,
    input.assetId,
    'platform_fee_revenue',
  );
  if (!buyerLocked || !sellerAvailable || !fees)
    throw new Error('Trade ledger accounts are incomplete.');
  return postJournal(client, {
    tenantId: input.tenantId,
    assetId: input.assetId,
    transactionType: 'trade',
    referenceType: 'trade',
    referenceRef: input.tradeRef,
    idempotencyKey: `trade:${input.tradeRef}`,
    postings: [
      {
        accountRef: buyerLocked.accountRef,
        accountId: buyerLocked.id,
        debitAtoms: input.gross + input.buyerFee,
      },
      {
        accountRef: sellerAvailable.accountRef,
        accountId: sellerAvailable.id,
        creditAtoms: input.gross - input.sellerFee,
      },
      {
        accountRef: fees.accountRef,
        accountId: fees.id,
        creditAtoms: input.buyerFee + input.sellerFee,
      },
    ],
  });
}

interface LedgerPosting {
  accountRef: string;
  accountId: string;
  debitAtoms?: bigint;
  creditAtoms?: bigint;
}

async function postJournal(
  client: SqlClient,
  input: {
    tenantId: string;
    assetId: string;
    transactionType: string;
    referenceType: string;
    referenceRef: string;
    idempotencyKey: string;
    postings: LedgerPosting[];
  },
): Promise<string> {
  assertBalancedPostings(input.postings);
  const existing = await client.query<{ id: string }>(
    `select id from public.ledger_journals where tenant_id = $1 and idempotency_key = $2`,
    [input.tenantId, input.idempotencyKey],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const journal = await client.query<{ id: string }>(
    `insert into public.ledger_journals
     (tenant_id, journal_ref, transaction_type, asset_id, reference_type,
      reference_ref, idempotency_key, effective_at)
     values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) returning id`,
    [
      input.tenantId,
      externalRef('ljr'),
      input.transactionType,
      input.assetId,
      input.referenceType,
      input.referenceRef,
      input.idempotencyKey,
    ],
  );
  for (const posting of input.postings) {
    await client.query(
      `insert into public.ledger_entries
       (tenant_id, journal_id, account_id, debit_atoms, credit_atoms)
       values ($1,$2,$3,$4,$5)`,
      [
        input.tenantId,
        journal.rows[0]!.id,
        posting.accountId,
        (posting.debitAtoms ?? 0n).toString(),
        (posting.creditAtoms ?? 0n).toString(),
      ],
    );
  }
  return journal.rows[0]!.id;
}

async function ledgerAccount(
  client: SqlClient,
  tenantId: string,
  userId: string | null,
  assetId: string,
  accountType: string,
): Promise<{ id: string; accountRef: string; balance: bigint } | null> {
  const result = await client.query<{
    id: string;
    account_ref: string;
    balance_atoms: string;
  }>(
    `select la.id, la.account_ref, coalesce(b.balance_atoms,0)::text as balance_atoms
     from public.ledger_accounts la
     left join public.ledger_account_balances b on b.account_id = la.id
     where la.tenant_id = $1 and la.owner_user_id is not distinct from $2
       and la.asset_id = $3 and la.account_type = $4 and la.status = 'active'
     for update of la`,
    [tenantId, userId, assetId, accountType],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, accountRef: row.account_ref, balance: BigInt(row.balance_atoms) }
    : null;
}

async function nextBookSequence(
  client: SqlClient,
  marketId: string,
  outcomeId: string,
): Promise<string> {
  const result = await client.query<{ last_sequence: string }>(
    `insert into public.market_book_sequences (market_id, outcome_id, last_sequence)
     values ($1,$2,1)
     on conflict (market_id,outcome_id) do update
     set last_sequence = public.market_book_sequences.last_sequence + 1,
       updated_at = clock_timestamp()
     returning last_sequence::text`,
    [marketId, outcomeId],
  );
  return result.rows[0]!.last_sequence;
}

async function emitOutbox(
  client: SqlClient,
  tenantId: string,
  channel: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 1))', [channel]);
  const sequence = await client.query<{ sequence: string }>(
    `select (coalesce(max(sequence),0) + 1)::text as sequence
     from public.outbox_events where channel = $1`,
    [channel],
  );
  await client.query(
    `insert into public.outbox_events
     (tenant_id, event_ref, aggregate_type, aggregate_ref, event_type,
      channel, sequence, payload_version, payload, occurred_at)
     values ($1,$2,'realtime',$3,$4,$3,$5,'1',$6,clock_timestamp())`,
    [tenantId, externalRef('evt'), channel, eventType, sequence.rows[0]!.sequence, payload],
  );
}

async function creditDeposit(client: SqlClient, event: VerifiedProviderEvent): Promise<void> {
  const intent = await client.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    asset_id: string;
    method: string;
    amount_atoms: string;
  }>(
    `select id, tenant_id, user_id, asset_id, method, amount_atoms::text
     from public.deposit_intents where intent_ref = $1 for update`,
    [event.resourceRef],
  );
  const row = intent.rows[0];
  if (!row) throw domainError('DEPOSIT_INTENT_NOT_FOUND', 'Deposit intent not found.', 404);
  if (row.amount_atoms !== event.amountAtoms) {
    throw domainError(
      'PROVIDER_AMOUNT_MISMATCH',
      'Provider amount does not match the deposit intent.',
      409,
    );
  }
  const existing = await client.query(
    `select 1 from public.deposits
     where provider_ref = 'configured-payment-provider' and provider_transaction_ref = $1`,
    [event.providerTransactionRef],
  );
  if (existing.rowCount) return;
  const available = await ledgerAccount(
    client,
    row.tenant_id,
    row.user_id,
    row.asset_id,
    'customer_available',
  );
  const treasury = await ledgerAccount(client, row.tenant_id, null, row.asset_id, 'treasury_cash');
  if (!available || !treasury) throw new Error('Deposit ledger accounts are incomplete.');
  const journalId = await postJournal(client, {
    tenantId: row.tenant_id,
    assetId: row.asset_id,
    transactionType: 'deposit_credit',
    referenceType: 'deposit',
    referenceRef: event.resourceRef,
    idempotencyKey: `deposit-credit:${event.providerTransactionRef}`,
    postings: [
      {
        accountRef: treasury.accountRef,
        accountId: treasury.id,
        debitAtoms: BigInt(event.amountAtoms),
      },
      {
        accountRef: available.accountRef,
        accountId: available.id,
        creditAtoms: BigInt(event.amountAtoms),
      },
    ],
  });
  await client.query(
    `insert into public.deposits
     (tenant_id, deposit_ref, deposit_intent_id, user_id, asset_id, method, amount_atoms,
      provider_ref, provider_transaction_ref, status, ledger_journal_id, received_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,'configured-payment-provider',$8,'credited',$9,$10,$10)`,
    [
      row.tenant_id,
      externalRef('dep'),
      row.id,
      row.user_id,
      row.asset_id,
      row.method,
      row.amount_atoms,
      event.providerTransactionRef,
      journalId,
      event.occurredAt,
    ],
  );
  await client.query(`update public.deposit_intents set status = 'credited' where id = $1`, [
    row.id,
  ]);
}

async function completeWithdrawal(client: SqlClient, event: VerifiedProviderEvent): Promise<void> {
  const row = await client.query<{
    tenant_id: string;
    user_id: string;
    asset_id: string;
    amount_atoms: string;
    withdrawal_id: string;
  }>(
    `select wr.tenant_id, wr.user_id, wr.asset_id, wr.amount_atoms::text,
      w.id as withdrawal_id
     from public.withdrawal_requests wr join public.withdrawals w on w.withdrawal_request_id = wr.id
     where wr.withdrawal_ref = $1 for update of wr, w`,
    [event.resourceRef],
  );
  const withdrawal = row.rows[0];
  if (!withdrawal) throw domainError('WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.', 404);
  if (withdrawal.amount_atoms !== event.amountAtoms) {
    throw domainError(
      'PROVIDER_AMOUNT_MISMATCH',
      'Provider amount does not match the withdrawal.',
      409,
    );
  }
  const pending = await ledgerAccount(
    client,
    withdrawal.tenant_id,
    withdrawal.user_id,
    withdrawal.asset_id,
    'customer_pending_withdrawal',
  );
  const treasury = await ledgerAccount(
    client,
    withdrawal.tenant_id,
    null,
    withdrawal.asset_id,
    'treasury_cash',
  );
  if (!pending || !treasury) throw new Error('Withdrawal ledger accounts are incomplete.');
  const journalId = await postJournal(client, {
    tenantId: withdrawal.tenant_id,
    assetId: withdrawal.asset_id,
    transactionType: 'withdrawal_completion',
    referenceType: 'withdrawal',
    referenceRef: event.resourceRef,
    idempotencyKey: `withdrawal-complete:${event.providerTransactionRef}`,
    postings: [
      {
        accountRef: pending.accountRef,
        accountId: pending.id,
        debitAtoms: BigInt(event.amountAtoms),
      },
      {
        accountRef: treasury.accountRef,
        accountId: treasury.id,
        creditAtoms: BigInt(event.amountAtoms),
      },
    ],
  });
  await client.query(
    `update public.withdrawals set status = 'completed', completion_journal_id = $2,
      provider_transaction_ref = $3, completed_at = $4 where id = $1`,
    [withdrawal.withdrawal_id, journalId, event.providerTransactionRef, event.occurredAt],
  );
}

async function failWithdrawal(client: SqlClient, event: VerifiedProviderEvent): Promise<void> {
  const row = await client.query<{
    tenant_id: string;
    user_id: string;
    asset_id: string;
    amount_atoms: string;
    withdrawal_id: string;
  }>(
    `select wr.tenant_id, wr.user_id, wr.asset_id, wr.amount_atoms::text,
      w.id as withdrawal_id
     from public.withdrawal_requests wr join public.withdrawals w on w.withdrawal_request_id = wr.id
     where wr.withdrawal_ref = $1 for update of wr, w`,
    [event.resourceRef],
  );
  const withdrawal = row.rows[0];
  if (!withdrawal) throw domainError('WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.', 404);
  const pending = await ledgerAccount(
    client,
    withdrawal.tenant_id,
    withdrawal.user_id,
    withdrawal.asset_id,
    'customer_pending_withdrawal',
  );
  const available = await ledgerAccount(
    client,
    withdrawal.tenant_id,
    withdrawal.user_id,
    withdrawal.asset_id,
    'customer_available',
  );
  if (!pending || !available) throw new Error('Withdrawal ledger accounts are incomplete.');
  await postJournal(client, {
    tenantId: withdrawal.tenant_id,
    assetId: withdrawal.asset_id,
    transactionType: 'withdrawal_release',
    referenceType: 'withdrawal',
    referenceRef: event.resourceRef,
    idempotencyKey: `withdrawal-release:${event.providerTransactionRef}`,
    postings: [
      {
        accountRef: pending.accountRef,
        accountId: pending.id,
        debitAtoms: BigInt(event.amountAtoms),
      },
      {
        accountRef: available.accountRef,
        accountId: available.id,
        creditAtoms: BigInt(event.amountAtoms),
      },
    ],
  });
  await client.query(`update public.withdrawals set status = 'failed' where id = $1`, [
    withdrawal.withdrawal_id,
  ]);
}

async function audit(
  client: SqlClient,
  principal: AuthPrincipal,
  action: string,
  resourceType: string,
  resourceRef: string,
  previousValue: unknown,
  newValue: unknown,
): Promise<void> {
  await client.query(
    `insert into public.audit_log
     (tenant_id, event_ref, actor_ref, actor_roles, action, resource_type,
      resource_ref, previous_value, new_value)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      principal.tenantId,
      externalRef('aud'),
      principal.userRef,
      principal.roles,
      action,
      resourceType,
      resourceRef,
      previousValue,
      newValue,
    ],
  );
}

function requestFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(value) || value < 0) {
    throw domainError('INVALID_CURSOR', 'Pagination cursor is invalid.', 400);
  }
  return value;
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function domainError(code: string, message: string, statusCode = 400): DomainError {
  return new DomainError(code, message, statusCode);
}
