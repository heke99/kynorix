import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  Balance,
  Market,
  Order,
  PlaceOrder,
  Position,
  ProposeResolution,
  RealtimeEvent,
  Trade,
} from '@kynorix/contracts';
import {
  DeterministicOrderBook,
  DoubleEntryLedger,
  PRODUCT_CATALOG,
  ResolutionWorkflow,
  basisPointsCeil,
  decideProductAccess,
  externalRef,
  parseAtoms,
  transitionMarket,
  type EngineTrade,
} from '@kynorix/core';

const TENANT_REF = 'tenant_kynorix_sandbox';
const ASSET = 'VSEK';
const MAKER_FEE_BPS = 5n;
const TAKER_FEE_BPS = 35n;

interface UserRecord {
  userRef: string;
  displayName: string;
  country: string;
  customerType: 'consumer' | 'business' | 'professional';
  kycLevel: string;
  role: 'customer' | 'market_maker' | 'admin';
}

interface InternalOrder {
  orderRef: string;
  userRef: string;
  marketRef: string;
  outcomeRef: string;
  side: 'buy' | 'sell';
  type: 'limit';
  priceAtoms: bigint;
  quantity: bigint;
  remainingQuantity: bigint;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  postOnly: boolean;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  status: Order['status'];
  sequence: bigint;
  createdAt: string;
  updatedAt: string;
  reservedAtoms: bigint;
  reservedQuantity: bigint;
}

interface InternalTrade {
  tradeRef: string;
  marketRef: string;
  outcomeRef: string;
  makerOrderRef: string;
  takerOrderRef: string;
  buyerUserRef: string;
  sellerUserRef: string;
  priceAtoms: bigint;
  quantity: bigint;
  buyerFeeAtoms: bigint;
  sellerFeeAtoms: bigint;
  sequence: bigint;
  executedAt: string;
}

interface InternalPosition {
  userRef: string;
  marketRef: string;
  outcomeRef: string;
  availableQuantity: bigint;
  lockedQuantity: bigint;
  totalCostAtoms: bigint;
  acquiredQuantity: bigint;
  realizedPnlAtoms: bigint;
  feesPaidAtoms: bigint;
}

export class SandboxStore {
  readonly events = new EventEmitter();
  readonly products = PRODUCT_CATALOG;

  private readonly users = new Map<string, UserRecord>();
  private readonly markets = new Map<string, Market>();
  private readonly books = new Map<string, DeterministicOrderBook>();
  private readonly orders = new Map<string, InternalOrder>();
  private readonly trades = new Map<string, InternalTrade>();
  private readonly positions = new Map<string, InternalPosition>();
  private readonly idempotency = new Map<string, string>();
  private readonly ledger = new DoubleEntryLedger();
  private readonly resolutions = new ResolutionWorkflow();
  private eventSequence = 0n;

  constructor() {
    this.seed();
  }

  listUsers(): UserRecord[] {
    return [...this.users.values()].filter((user) => user.role !== 'market_maker');
  }

  getUser(userRef: string): UserRecord {
    const user = this.users.get(userRef);
    if (!user) throw domainError('USER_NOT_FOUND', `Unknown sandbox user: ${userRef}`);
    return user;
  }

  listMarkets(): Market[] {
    return [...this.markets.values()]
      .filter((market) => market.status !== 'archived')
      .sort((a, b) => Number(b.featured) - Number(a.featured));
  }

  getMarket(marketRef: string): Market {
    const market = this.markets.get(marketRef);
    if (!market) throw domainError('MARKET_NOT_FOUND', 'Market does not exist');
    return market;
  }

  getOrderbook(marketRef: string, outcomeRef?: string) {
    const market = this.getMarket(marketRef);
    const selectedOutcome = outcomeRef ?? market.outcomes[0]!.outcomeRef;
    this.assertOutcome(market, selectedOutcome);
    return {
      marketRef,
      outcomeRef: selectedOutcome,
      ...this.book(marketRef, selectedOutcome).snapshot(),
    };
  }

  listTrades(marketRef: string, limit = 100): Trade[] {
    this.getMarket(marketRef);
    return [...this.trades.values()]
      .filter((trade) => trade.marketRef === marketRef)
      .sort((a, b) => (a.sequence > b.sequence ? -1 : 1))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(serializeTrade);
  }

  placeOrder(userRef: string, input: PlaceOrder): Order {
    const user = this.getUser(userRef);
    const market = this.getMarket(input.marketRef);
    if (market.status !== 'open') {
      throw domainError('MARKET_NOT_OPEN', `Market is ${market.status}`);
    }
    this.assertOutcome(market, input.outcomeRef);

    const access = decideProductAccess(market.productType, {
      country: user.country,
      customerType: user.customerType,
      kycLevel: user.kycLevel,
      channel: 'web',
      selfExcluded: false,
      sanctionsHit: false,
    });
    if (access.decision !== 'allowed' && access.decision !== 'allowed_with_limits') {
      throw domainError('PRODUCT_ACCESS_DENIED', access.reasonCode);
    }

    const idempotencyKey = `${userRef}:${input.idempotencyKey}`;
    const fingerprint = sha256(
      JSON.stringify({
        ...input,
        timeInForce: input.timeInForce ?? 'GTC',
        postOnly: input.postOnly ?? false,
      }),
    );
    const existingRef = this.idempotency.get(idempotencyKey);
    if (existingRef) {
      const existing = this.orders.get(existingRef)!;
      if (existing.idempotencyFingerprint !== fingerprint) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'Key was already used for another request');
      }
      return serializeOrder(existing);
    }

    const priceAtoms = parseAtoms(input.priceAtoms, 'priceAtoms');
    const quantity = parseAtoms(input.quantity, 'quantity');
    const payoutAtoms = parseAtoms(market.payoutAtoms, 'payoutAtoms');
    const tickAtoms = parseAtoms(market.tickAtoms, 'tickAtoms');
    const minimumOrderQuantity = parseAtoms(market.minimumOrderQuantity);
    if (priceAtoms <= 0n || priceAtoms >= payoutAtoms || priceAtoms % tickAtoms !== 0n) {
      throw domainError('INVALID_PRICE', 'Price must be inside payout bounds and follow tick size');
    }
    if (quantity < minimumOrderQuantity) {
      throw domainError('INVALID_QUANTITY', 'Quantity is below the minimum order size');
    }

    const orderRef = externalRef('ord');
    let reservedAtoms = 0n;
    let reservedQuantity = 0n;
    if (input.side === 'buy') {
      reservedAtoms = priceAtoms * quantity + basisPointsCeil(priceAtoms * quantity, TAKER_FEE_BPS);
      this.moveAvailableToLocked(userRef, reservedAtoms, orderRef);
    } else {
      this.lockPosition(userRef, input.marketRef, input.outcomeRef, quantity);
      reservedQuantity = quantity;
    }

    let match;
    try {
      match = this.book(input.marketRef, input.outcomeRef).accept({
        orderRef,
        userRef,
        marketRef: input.marketRef,
        outcomeRef: input.outcomeRef,
        side: input.side,
        priceAtoms,
        quantity,
        timeInForce: input.timeInForce ?? 'GTC',
        postOnly: input.postOnly ?? false,
      });
    } catch (error) {
      if (input.side === 'buy') this.moveLockedToAvailable(userRef, reservedAtoms, orderRef);
      else this.unlockPosition(userRef, input.marketRef, input.outcomeRef, reservedQuantity);
      throw error;
    }

    const createdAt = new Date().toISOString();
    const internal: InternalOrder = {
      orderRef,
      userRef,
      marketRef: input.marketRef,
      outcomeRef: input.outcomeRef,
      side: input.side,
      type: 'limit',
      priceAtoms,
      quantity,
      remainingQuantity: quantity,
      timeInForce: input.timeInForce ?? 'GTC',
      postOnly: input.postOnly ?? false,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: fingerprint,
      status: 'accepted',
      sequence: match.accepted.sequence,
      createdAt,
      updatedAt: createdAt,
      reservedAtoms,
      reservedQuantity,
    };
    this.orders.set(orderRef, internal);
    this.idempotency.set(idempotencyKey, orderRef);

    for (const trade of match.trades) this.commitTrade(trade, orderRef);
    this.refreshOrder(internal, match.cancelledRemainder);
    this.reconcileReservation(internal);
    for (const trade of match.trades) {
      const maker = this.orders.get(trade.makerOrderRef);
      if (maker) {
        this.refreshOrder(maker, false);
        this.reconcileReservation(maker);
      }
    }
    this.publish(`user.${userRef}.orders`, 'OrderAccepted', serializeOrder(internal));
    this.publish(
      `market.${input.marketRef}.book`,
      'OrderBookChanged',
      this.getOrderbook(input.marketRef, input.outcomeRef),
    );
    return serializeOrder(internal);
  }

  cancelOrder(userRef: string, orderRef: string): Order {
    const order = this.orders.get(orderRef);
    if (!order || order.userRef !== userRef) {
      throw domainError('ORDER_NOT_FOUND', 'Order does not exist');
    }
    if (order.status !== 'open' && order.status !== 'partially_filled') {
      return serializeOrder(order);
    }
    this.book(order.marketRef, order.outcomeRef).cancel(orderRef, userRef);
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    order.remainingQuantity = 0n;
    this.reconcileReservation(order);
    this.publish(`user.${userRef}.orders`, 'OrderCancelled', serializeOrder(order));
    this.publish(
      `market.${order.marketRef}.book`,
      'OrderBookChanged',
      this.getOrderbook(order.marketRef, order.outcomeRef),
    );
    return serializeOrder(order);
  }

  listOrders(userRef: string): Order[] {
    this.getUser(userRef);
    return [...this.orders.values()]
      .filter((order) => order.userRef === userRef)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(serializeOrder);
  }

  listPositions(userRef: string): Position[] {
    this.getUser(userRef);
    return [...this.positions.values()]
      .filter(
        (position) =>
          position.userRef === userRef &&
          (position.availableQuantity > 0n || position.lockedQuantity > 0n),
      )
      .map((position) => ({
        marketRef: position.marketRef,
        outcomeRef: position.outcomeRef,
        availableQuantity: position.availableQuantity.toString(),
        lockedQuantity: position.lockedQuantity.toString(),
        averageEntryPriceAtoms:
          position.acquiredQuantity === 0n
            ? '0'
            : (position.totalCostAtoms / position.acquiredQuantity).toString(),
        realizedPnlAtoms: position.realizedPnlAtoms.toString(),
        feesPaidAtoms: position.feesPaidAtoms.toString(),
      }));
  }

  listBalances(userRef: string): Balance[] {
    this.getUser(userRef);
    return [
      {
        asset: ASSET,
        availableAtoms: this.ledger.balance(accountRef(userRef, 'available')).toString(),
        lockedAtoms: this.ledger.balance(accountRef(userRef, 'locked')).toString(),
      },
    ];
  }

  listLedger(userRef: string) {
    this.getUser(userRef);
    return this.ledger.listJournals(TENANT_REF, userRef).map((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => ({
        ...entry,
        debitAtoms: entry.debitAtoms.toString(),
        creditAtoms: entry.creditAtoms.toString(),
        accountType: this.ledger.getAccount(entry.accountRef)?.accountType,
      })),
    }));
  }

  transitionMarket(marketRef: string, targetStatus: Market['status']): Market {
    const market = this.getMarket(marketRef);
    market.status = transitionMarket(market.status, targetStatus);
    this.publish(`market.${marketRef}.ticker`, 'MarketStatusChanged', {
      marketRef,
      status: market.status,
    });
    return market;
  }

  closeForResolution(marketRef: string): Market {
    let market = this.getMarket(marketRef);
    if (market.status === 'open') {
      market = this.transitionMarket(marketRef, 'closing');
      for (const order of this.orders.values()) {
        if (
          order.marketRef === marketRef &&
          (order.status === 'open' || order.status === 'partially_filled')
        ) {
          this.cancelOrder(order.userRef, order.orderRef);
        }
      }
    }
    if (market.status === 'closing') market = this.transitionMarket(marketRef, 'closed');
    if (market.status === 'closed') market = this.transitionMarket(marketRef, 'resolution_pending');
    if (market.status !== 'resolution_pending') {
      throw domainError('MARKET_NOT_RESOLUTION_READY', `Market is ${market.status}`);
    }
    return market;
  }

  proposeResolution(marketRef: string, officerRef: string, input: ProposeResolution) {
    const market = this.getMarket(marketRef);
    if (market.status !== 'resolution_pending' && market.status !== 'disputed') {
      throw domainError('MARKET_NOT_RESOLUTION_READY', `Market is ${market.status}`);
    }
    this.assertOutcome(market, input.outcomeRef);
    return this.resolutions.propose({
      marketRef,
      outcomeRef: input.outcomeRef,
      proposedBy: officerRef,
      reason: input.reason,
      evidence: input.evidence,
    });
  }

  approveResolution(proposalRef: string, officerRef: string) {
    const proposal = this.resolutions.approve(proposalRef, officerRef);
    const market = this.getMarket(proposal.marketRef);
    if (proposal.status === 'approved' && market.status !== 'settled') {
      market.status = transitionMarket(market.status, 'resolved');
      market.status = transitionMarket(market.status, 'settling');
      this.settleMarket(market, proposal.outcomeRef);
      market.status = transitionMarket(market.status, 'settled');
      this.publish(`market.${market.marketRef}.ticker`, 'MarketSettled', {
        marketRef: market.marketRef,
        outcomeRef: proposal.outcomeRef,
        proposalRef,
      });
    }
    return { proposal, market };
  }

  capabilities() {
    return {
      release: 'sandbox-2026-07-30.1',
      sandbox: true,
      enabled: ['virtual_prediction', 'b2b_private_prediction'],
      denied: [
        'real_money_prediction',
        'spot_crypto',
        'custody',
        'fiat_deposits',
        'fiat_withdrawals',
        'crypto_deposits',
        'crypto_withdrawals',
        'five_minute_up_down',
        'binary_option',
        'gold_exposure',
      ],
      policyEnforcement: 'server',
    };
  }

  private seed(): void {
    const users: UserRecord[] = [
      {
        userRef: 'demo-alex',
        displayName: 'Alex',
        country: 'SE',
        customerType: 'consumer',
        kycLevel: 'basic',
        role: 'customer',
      },
      {
        userRef: 'demo-sam',
        displayName: 'Sam',
        country: 'SE',
        customerType: 'consumer',
        kycLevel: 'basic',
        role: 'customer',
      },
      {
        userRef: 'market-maker-a',
        displayName: 'Sandbox Liquidity A',
        country: 'SE',
        customerType: 'professional',
        kycLevel: 'institution_verified',
        role: 'market_maker',
      },
      {
        userRef: 'market-maker-b',
        displayName: 'Sandbox Liquidity B',
        country: 'SE',
        customerType: 'professional',
        kycLevel: 'institution_verified',
        role: 'market_maker',
      },
    ];
    this.ledger.createAccount({
      accountRef: 'acct:treasury',
      tenantRef: TENANT_REF,
      ownerRef: null,
      asset: ASSET,
      accountType: 'treasury_cash',
      normalSide: 'debit',
    });
    this.ledger.createAccount({
      accountRef: 'acct:collateral',
      tenantRef: TENANT_REF,
      ownerRef: null,
      asset: ASSET,
      accountType: 'collateral_locked',
      normalSide: 'credit',
    });
    this.ledger.createAccount({
      accountRef: 'acct:fees',
      tenantRef: TENANT_REF,
      ownerRef: null,
      asset: ASSET,
      accountType: 'platform_fee_revenue',
      normalSide: 'credit',
    });
    this.ledger.post({
      tenantRef: TENANT_REF,
      transactionType: 'sandbox_collateralisation',
      asset: ASSET,
      referenceType: 'sandbox_seed',
      referenceRef: 'seed-collateral',
      idempotencyKey: 'seed:collateral',
      postings: [
        { accountRef: 'acct:treasury', debitAtoms: 100_000_000n },
        { accountRef: 'acct:collateral', creditAtoms: 100_000_000n },
      ],
    });
    for (const user of users) {
      this.users.set(user.userRef, user);
      this.ledger.createAccount({
        accountRef: accountRef(user.userRef, 'available'),
        tenantRef: TENANT_REF,
        ownerRef: user.userRef,
        asset: ASSET,
        accountType: 'customer_available',
        normalSide: 'credit',
      });
      this.ledger.createAccount({
        accountRef: accountRef(user.userRef, 'locked'),
        tenantRef: TENANT_REF,
        ownerRef: user.userRef,
        asset: ASSET,
        accountType: 'customer_locked',
        normalSide: 'credit',
      });
      this.ledger.post({
        tenantRef: TENANT_REF,
        transactionType: 'sandbox_grant',
        asset: ASSET,
        referenceType: 'sandbox_seed',
        referenceRef: user.userRef,
        idempotencyKey: `seed:grant:${user.userRef}`,
        postings: [
          { accountRef: 'acct:treasury', debitAtoms: 1_000_000n },
          { accountRef: accountRef(user.userRef, 'available'), creditAtoms: 1_000_000n },
        ],
      });
    }

    const now = Date.now();
    const markets: Market[] = [
      makeMarket({
        marketRef: 'mkt_riksbank_2026',
        title: 'Sänker Riksbanken styrräntan vid nästa besked?',
        question:
          'Kommer Riksbanken att meddela en lägre styrränta än föregående beslutad nivå vid nästa ordinarie räntebesked?',
        category: 'Ekonomi',
        source: 'https://www.riksbank.se/sv/penningpolitik/penningpolitiska-beslut/',
        now,
        featured: true,
      }),
      makeMarket({
        marketRef: 'mkt_eu_ai_2027',
        title: 'Antas en ny EU-gemensam AI-tillsynsstandard före 2027?',
        question:
          'Kommer EU:s officiella rättsdatabas att publicera en ny bindande unionsstandard för gemensam AI-tillsyn före 1 januari 2027?',
        category: 'Teknik',
        source: 'https://eur-lex.europa.eu/',
        now,
        featured: true,
      }),
      makeMarket({
        marketRef: 'mkt_swe_growth_2026',
        title: 'Överstiger svensk BNP-tillväxt 1,5 % för helåret?',
        question:
          'Är den första officiella helårsnoteringen för svensk real BNP-tillväxt 2026 högre än 1,5 procent?',
        category: 'Makro',
        source: 'https://www.scb.se/',
        now,
        featured: false,
      }),
    ];
    for (const market of markets) {
      this.markets.set(market.marketRef, market);
      for (const outcome of market.outcomes) {
        this.books.set(
          bookKey(market.marketRef, outcome.outcomeRef),
          new DeterministicOrderBook(market.marketRef, outcome.outcomeRef),
        );
        this.position('market-maker-a', market.marketRef, outcome.outcomeRef).availableQuantity =
          10_000n;
      }
    }

    for (const market of markets) {
      for (const outcome of market.outcomes) {
        this.placeOrder('market-maker-a', {
          marketRef: market.marketRef,
          outcomeRef: outcome.outcomeRef,
          side: 'sell',
          type: 'limit',
          priceAtoms: outcome.outcomeRef.endsWith('yes') ? '55' : '50',
          quantity: '2000',
          timeInForce: 'GTC',
          postOnly: true,
          idempotencyKey: `seed-ask-${market.marketRef}-${outcome.outcomeRef}`,
        });
        this.placeOrder('market-maker-b', {
          marketRef: market.marketRef,
          outcomeRef: outcome.outcomeRef,
          side: 'buy',
          type: 'limit',
          priceAtoms: outcome.outcomeRef.endsWith('yes') ? '45' : '40',
          quantity: '2000',
          timeInForce: 'GTC',
          postOnly: true,
          idempotencyKey: `seed-bid-${market.marketRef}-${outcome.outcomeRef}`,
        });
      }
    }
    this.ledger.assertBalanced();
  }

  private book(marketRef: string, outcomeRef: string): DeterministicOrderBook {
    const book = this.books.get(bookKey(marketRef, outcomeRef));
    if (!book) throw domainError('ORDERBOOK_NOT_FOUND', 'Order book does not exist');
    return book;
  }

  private assertOutcome(market: Market, outcomeRef: string): void {
    if (!market.outcomes.some((outcome) => outcome.outcomeRef === outcomeRef)) {
      throw domainError('OUTCOME_NOT_FOUND', 'Outcome does not belong to market');
    }
  }

  private moveAvailableToLocked(userRef: string, amount: bigint, referenceRef: string): void {
    this.ledger.post({
      tenantRef: TENANT_REF,
      transactionType: 'order_reservation',
      asset: ASSET,
      referenceType: 'order',
      referenceRef,
      idempotencyKey: `reserve:${referenceRef}`,
      postings: [
        { accountRef: accountRef(userRef, 'available'), debitAtoms: amount },
        { accountRef: accountRef(userRef, 'locked'), creditAtoms: amount },
      ],
    });
  }

  private moveLockedToAvailable(userRef: string, amount: bigint, referenceRef: string): void {
    if (amount === 0n) return;
    this.ledger.post({
      tenantRef: TENANT_REF,
      transactionType: 'order_reservation_release',
      asset: ASSET,
      referenceType: 'order',
      referenceRef,
      idempotencyKey: `release:${referenceRef}:${amount}`,
      postings: [
        { accountRef: accountRef(userRef, 'locked'), debitAtoms: amount },
        { accountRef: accountRef(userRef, 'available'), creditAtoms: amount },
      ],
    });
  }

  private commitTrade(trade: EngineTrade, incomingOrderRef: string): void {
    const buyer = this.orders.get(
      trade.takerOrderRef === incomingOrderRef &&
        trade.buyerUserRef === this.orders.get(incomingOrderRef)?.userRef
        ? incomingOrderRef
        : trade.makerOrderRef,
    );
    const seller = this.orders.get(
      trade.takerOrderRef === incomingOrderRef &&
        trade.sellerUserRef === this.orders.get(incomingOrderRef)?.userRef
        ? incomingOrderRef
        : trade.makerOrderRef,
    );
    const incoming = this.orders.get(incomingOrderRef)!;
    const buyerOrder = incoming.userRef === trade.buyerUserRef ? incoming : buyer;
    const sellerOrder = incoming.userRef === trade.sellerUserRef ? incoming : seller;
    if (!buyerOrder || !sellerOrder) throw new Error('Trade order state is incomplete');

    const gross = trade.priceAtoms * trade.quantity;
    const buyerIsTaker = trade.takerOrderRef === buyerOrder.orderRef;
    const sellerIsTaker = trade.takerOrderRef === sellerOrder.orderRef;
    const buyerFee = basisPointsCeil(gross, buyerIsTaker ? TAKER_FEE_BPS : MAKER_FEE_BPS);
    const sellerFee = basisPointsCeil(gross, sellerIsTaker ? TAKER_FEE_BPS : MAKER_FEE_BPS);
    this.ledger.post({
      tenantRef: TENANT_REF,
      transactionType: 'trade',
      asset: ASSET,
      referenceType: 'trade',
      referenceRef: trade.tradeRef,
      idempotencyKey: `trade:${trade.tradeRef}`,
      postings: [
        {
          accountRef: accountRef(trade.buyerUserRef, 'locked'),
          debitAtoms: gross + buyerFee,
        },
        {
          accountRef: accountRef(trade.sellerUserRef, 'available'),
          creditAtoms: gross - sellerFee,
        },
        { accountRef: 'acct:fees', creditAtoms: buyerFee + sellerFee },
      ],
    });
    buyerOrder.reservedAtoms -= gross + buyerFee;
    sellerOrder.reservedQuantity -= trade.quantity;

    const buyerPosition = this.position(trade.buyerUserRef, trade.marketRef, trade.outcomeRef);
    const sellerPosition = this.position(trade.sellerUserRef, trade.marketRef, trade.outcomeRef);
    sellerPosition.lockedQuantity -= trade.quantity;
    buyerPosition.availableQuantity += trade.quantity;
    buyerPosition.totalCostAtoms += gross;
    buyerPosition.acquiredQuantity += trade.quantity;
    buyerPosition.feesPaidAtoms += buyerFee;
    sellerPosition.feesPaidAtoms += sellerFee;

    buyerOrder.remainingQuantity -= trade.quantity;
    sellerOrder.remainingQuantity -= trade.quantity;
    const stored: InternalTrade = {
      ...trade,
      buyerFeeAtoms: buyerFee,
      sellerFeeAtoms: sellerFee,
    };
    this.trades.set(stored.tradeRef, stored);
    this.publish(`market.${trade.marketRef}.trades`, 'TradeExecuted', serializeTrade(stored));
    this.publish(`user.${trade.buyerUserRef}.fills`, 'TradeExecuted', serializeTrade(stored));
    this.publish(`user.${trade.sellerUserRef}.fills`, 'TradeExecuted', serializeTrade(stored));
  }

  private refreshOrder(order: InternalOrder, cancelledRemainder: boolean): void {
    if (cancelledRemainder) {
      order.status = order.quantity === order.remainingQuantity ? 'cancelled' : 'partially_filled';
      order.remainingQuantity = 0n;
    } else if (order.remainingQuantity === 0n) {
      order.status = 'filled';
    } else if (order.remainingQuantity < order.quantity) {
      order.status = 'partially_filled';
    } else {
      order.status = 'open';
    }
    order.updatedAt = new Date().toISOString();
  }

  private reconcileReservation(order: InternalOrder): void {
    if (order.side === 'buy') {
      const required =
        order.status === 'open' || order.status === 'partially_filled'
          ? order.priceAtoms * order.remainingQuantity +
            basisPointsCeil(order.priceAtoms * order.remainingQuantity, TAKER_FEE_BPS)
          : 0n;
      if (order.reservedAtoms > required) {
        const release = order.reservedAtoms - required;
        order.reservedAtoms = required;
        this.moveLockedToAvailable(order.userRef, release, order.orderRef);
      }
    } else {
      const required =
        order.status === 'open' || order.status === 'partially_filled'
          ? order.remainingQuantity
          : 0n;
      if (order.reservedQuantity > required) {
        const release = order.reservedQuantity - required;
        order.reservedQuantity = required;
        this.unlockPosition(order.userRef, order.marketRef, order.outcomeRef, release);
      }
    }
  }

  private position(userRef: string, marketRef: string, outcomeRef: string): InternalPosition {
    const key = `${userRef}:${marketRef}:${outcomeRef}`;
    let position = this.positions.get(key);
    if (!position) {
      position = {
        userRef,
        marketRef,
        outcomeRef,
        availableQuantity: 0n,
        lockedQuantity: 0n,
        totalCostAtoms: 0n,
        acquiredQuantity: 0n,
        realizedPnlAtoms: 0n,
        feesPaidAtoms: 0n,
      };
      this.positions.set(key, position);
    }
    return position;
  }

  private lockPosition(
    userRef: string,
    marketRef: string,
    outcomeRef: string,
    quantity: bigint,
  ): void {
    const position = this.position(userRef, marketRef, outcomeRef);
    if (position.availableQuantity < quantity) {
      throw domainError('INSUFFICIENT_POSITION', 'Not enough available outcome units');
    }
    position.availableQuantity -= quantity;
    position.lockedQuantity += quantity;
  }

  private unlockPosition(
    userRef: string,
    marketRef: string,
    outcomeRef: string,
    quantity: bigint,
  ): void {
    if (quantity === 0n) return;
    const position = this.position(userRef, marketRef, outcomeRef);
    if (position.lockedQuantity < quantity) throw new Error('Position lock underflow');
    position.lockedQuantity -= quantity;
    position.availableQuantity += quantity;
  }

  private settleMarket(market: Market, winningOutcomeRef: string): void {
    const payoutAtoms = parseAtoms(market.payoutAtoms);
    for (const position of this.positions.values()) {
      if (position.marketRef !== market.marketRef) continue;
      if (position.lockedQuantity > 0n) {
        throw domainError('OPEN_ORDERS_BLOCK_SETTLEMENT', 'Cancel all open orders first');
      }
      if (position.outcomeRef === winningOutcomeRef && position.availableQuantity > 0n) {
        const payout = position.availableQuantity * payoutAtoms;
        this.ledger.post({
          tenantRef: TENANT_REF,
          transactionType: 'market_settlement',
          asset: ASSET,
          referenceType: 'market',
          referenceRef: market.marketRef,
          idempotencyKey: `settle:${market.marketRef}:${position.userRef}`,
          postings: [
            { accountRef: 'acct:collateral', debitAtoms: payout },
            { accountRef: accountRef(position.userRef, 'available'), creditAtoms: payout },
          ],
        });
        position.realizedPnlAtoms += payout - position.totalCostAtoms;
      } else {
        position.realizedPnlAtoms -= position.totalCostAtoms;
      }
      position.availableQuantity = 0n;
      position.totalCostAtoms = 0n;
      position.acquiredQuantity = 0n;
    }
    this.ledger.assertBalanced();
  }

  private publish(channel: string, eventType: string, payload: unknown): void {
    const now = new Date().toISOString();
    const event: RealtimeEvent = {
      sequence: (++this.eventSequence).toString(),
      eventId: externalRef('evt'),
      channel,
      eventType,
      serverTimestamp: now,
      marketTimestamp: now,
      payloadVersion: '1',
      payload,
    };
    this.events.emit('event', event);
  }
}

function accountRef(userRef: string, bucket: 'available' | 'locked'): string {
  return `acct:${userRef}:${bucket}`;
}

function bookKey(marketRef: string, outcomeRef: string): string {
  return `${marketRef}:${outcomeRef}`;
}

function positionRef(marketRef: string, suffix: 'yes' | 'no'): string {
  return `${marketRef}_${suffix}`;
}

function makeMarket(input: {
  marketRef: string;
  title: string;
  question: string;
  category: string;
  source: string;
  now: number;
  featured: boolean;
}): Market {
  return {
    marketRef: input.marketRef,
    tenantRef: TENANT_REF,
    productType: 'virtual_prediction',
    title: input.title,
    question: input.question,
    category: input.category,
    rules:
      'JA avgörs endast om den namngivna primärkällan uttryckligen bekräftar utfallet före stängning. I annat fall avgörs NEJ. Vid otillgänglig eller motsägelsefull källa pausas resolution för manuell granskning.',
    resolutionSource: input.source,
    resolutionTime: new Date(input.now + 1000 * 60 * 60 * 24 * 31).toISOString(),
    opensAt: new Date(input.now - 1000 * 60 * 60).toISOString(),
    closesAt: new Date(input.now + 1000 * 60 * 60 * 24 * 30).toISOString(),
    displayTimezone: 'Europe/Stockholm',
    status: 'open',
    collateralAsset: ASSET,
    payoutAtoms: '100',
    tickAtoms: '1',
    minimumOrderQuantity: '1',
    maximumPositionQuantity: '10000',
    feeVersion: 'virtual_fee_v1',
    immutableRuleVersion: 'rules_2026-07-30.1',
    outcomes: [
      { outcomeRef: positionRef(input.marketRef, 'yes'), label: 'JA', displayOrder: 0 },
      { outcomeRef: positionRef(input.marketRef, 'no'), label: 'NEJ', displayOrder: 1 },
    ],
    featured: input.featured,
  };
}

function serializeOrder(order: InternalOrder): Order {
  return {
    marketRef: order.marketRef,
    outcomeRef: order.outcomeRef,
    side: order.side,
    type: 'limit',
    priceAtoms: order.priceAtoms.toString(),
    quantity: order.quantity.toString(),
    timeInForce: order.timeInForce,
    postOnly: order.postOnly,
    idempotencyKey: order.idempotencyKey,
    orderRef: order.orderRef,
    userRef: order.userRef,
    status: order.status,
    remainingQuantity: order.remainingQuantity.toString(),
    sequence: order.sequence.toString(),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function serializeTrade(trade: InternalTrade): Trade {
  return {
    tradeRef: trade.tradeRef,
    marketRef: trade.marketRef,
    outcomeRef: trade.outcomeRef,
    makerOrderRef: trade.makerOrderRef,
    takerOrderRef: trade.takerOrderRef,
    buyerUserRef: trade.buyerUserRef,
    sellerUserRef: trade.sellerUserRef,
    priceAtoms: trade.priceAtoms.toString(),
    quantity: trade.quantity.toString(),
    buyerFeeAtoms: trade.buyerFeeAtoms.toString(),
    sellerFeeAtoms: trade.sellerFeeAtoms.toString(),
    sequence: trade.sequence.toString(),
    executedAt: trade.executedAt,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DomainError extends Error {
  code: string;
  statusCode: number;
}

export function domainError(code: string, message: string, statusCode = 400): DomainError {
  return Object.assign(new Error(message), { code, statusCode });
}
