import type { OrderSide, TimeInForce } from '@kynorix/contracts';
import { externalRef } from './id.js';

export interface EngineOrder {
  orderRef: string;
  userRef: string;
  marketRef: string;
  outcomeRef: string;
  side: OrderSide;
  priceAtoms: bigint;
  quantity: bigint;
  remainingQuantity: bigint;
  timeInForce: TimeInForce;
  postOnly: boolean;
  sequence: bigint;
  createdAt: string;
}

export interface EngineTrade {
  tradeRef: string;
  makerOrderRef: string;
  takerOrderRef: string;
  buyerUserRef: string;
  sellerUserRef: string;
  marketRef: string;
  outcomeRef: string;
  priceAtoms: bigint;
  quantity: bigint;
  sequence: bigint;
  executedAt: string;
}

export interface MatchResult {
  accepted: EngineOrder;
  trades: EngineTrade[];
  resting: boolean;
  cancelledRemainder: boolean;
}

export class DeterministicOrderBook {
  private readonly buys: EngineOrder[] = [];
  private readonly sells: EngineOrder[] = [];
  private sequence = 0n;

  constructor(
    readonly marketRef: string,
    readonly outcomeRef: string,
  ) {}

  accept(input: Omit<EngineOrder, 'remainingQuantity' | 'sequence' | 'createdAt'>): MatchResult {
    if (input.marketRef !== this.marketRef || input.outcomeRef !== this.outcomeRef) {
      throw new Error('Order routed to the wrong order-book partition');
    }
    if (input.priceAtoms <= 0n || input.quantity <= 0n) {
      throw new Error('Price and quantity must be positive');
    }

    const opposite = input.side === 'buy' ? this.sells : this.buys;
    const available = this.executableQuantity(input.side, input.priceAtoms);
    if (
      opposite.some(
        (order) =>
          order.userRef === input.userRef &&
          crosses(input.side, input.priceAtoms, order.priceAtoms),
      )
    ) {
      throw new Error('SELF_TRADE_PREVENTED');
    }
    if (input.timeInForce === 'FOK' && available < input.quantity) {
      throw new Error('FOK_NOT_FILLABLE');
    }
    if (input.postOnly && available > 0n) {
      throw new Error('POST_ONLY_WOULD_TRADE');
    }

    const order: EngineOrder = {
      ...input,
      remainingQuantity: input.quantity,
      sequence: ++this.sequence,
      createdAt: new Date().toISOString(),
    };
    const trades: EngineTrade[] = [];

    while (order.remainingQuantity > 0n) {
      this.sortSide(opposite, input.side === 'buy' ? 'sell' : 'buy');
      const maker = opposite[0];
      if (!maker || !crosses(order.side, order.priceAtoms, maker.priceAtoms)) break;
      const quantity =
        order.remainingQuantity < maker.remainingQuantity
          ? order.remainingQuantity
          : maker.remainingQuantity;
      order.remainingQuantity -= quantity;
      maker.remainingQuantity -= quantity;
      trades.push({
        tradeRef: externalRef('trd'),
        makerOrderRef: maker.orderRef,
        takerOrderRef: order.orderRef,
        buyerUserRef: order.side === 'buy' ? order.userRef : maker.userRef,
        sellerUserRef: order.side === 'sell' ? order.userRef : maker.userRef,
        marketRef: this.marketRef,
        outcomeRef: this.outcomeRef,
        priceAtoms: maker.priceAtoms,
        quantity,
        sequence: ++this.sequence,
        executedAt: new Date().toISOString(),
      });
      if (maker.remainingQuantity === 0n) opposite.shift();
    }

    const cancelledRemainder =
      order.remainingQuantity > 0n && (order.timeInForce === 'IOC' || order.timeInForce === 'FOK');
    const resting = order.remainingQuantity > 0n && !cancelledRemainder;
    if (resting) {
      const ownSide = order.side === 'buy' ? this.buys : this.sells;
      ownSide.push(order);
      this.sortSide(ownSide, order.side);
    }
    return { accepted: order, trades, resting, cancelledRemainder };
  }

  cancel(orderRef: string, userRef: string): EngineOrder {
    for (const side of [this.buys, this.sells]) {
      const index = side.findIndex(
        (order) => order.orderRef === orderRef && order.userRef === userRef,
      );
      if (index >= 0) return side.splice(index, 1)[0]!;
    }
    throw new Error('OPEN_ORDER_NOT_FOUND');
  }

  snapshot(depth = 20): {
    sequence: string;
    bids: Array<{ priceAtoms: string; quantity: string }>;
    asks: Array<{ priceAtoms: string; quantity: string }>;
  } {
    return {
      sequence: this.sequence.toString(),
      bids: aggregate(this.buys).slice(0, depth),
      asks: aggregate(this.sells).slice(0, depth),
    };
  }

  getSequence(): bigint {
    return this.sequence;
  }

  private executableQuantity(side: OrderSide, limit: bigint): bigint {
    const opposite = side === 'buy' ? this.sells : this.buys;
    return opposite
      .filter((order) => crosses(side, limit, order.priceAtoms))
      .reduce((sum, order) => sum + order.remainingQuantity, 0n);
  }

  private sortSide(orders: EngineOrder[], side: OrderSide): void {
    orders.sort((a, b) => {
      if (a.priceAtoms !== b.priceAtoms) {
        if (side === 'buy') return a.priceAtoms > b.priceAtoms ? -1 : 1;
        return a.priceAtoms < b.priceAtoms ? -1 : 1;
      }
      return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0;
    });
  }
}

function crosses(side: OrderSide, takerLimit: bigint, makerPrice: bigint): boolean {
  return side === 'buy' ? makerPrice <= takerLimit : makerPrice >= takerLimit;
}

function aggregate(orders: EngineOrder[]): Array<{ priceAtoms: string; quantity: string }> {
  const levels = new Map<bigint, bigint>();
  for (const order of orders) {
    levels.set(order.priceAtoms, (levels.get(order.priceAtoms) ?? 0n) + order.remainingQuantity);
  }
  return [...levels].map(([priceAtoms, quantity]) => ({
    priceAtoms: priceAtoms.toString(),
    quantity: quantity.toString(),
  }));
}
