import type { MarketStatus } from '@zoryqon/contracts';

const transitions: Readonly<Record<MarketStatus, readonly MarketStatus[]>> = {
  draft: ['under_review', 'cancelled'],
  under_review: ['approved', 'draft', 'cancelled'],
  approved: ['scheduled', 'cancelled'],
  scheduled: ['pre_open', 'cancelled'],
  pre_open: ['open', 'suspended', 'cancelled'],
  open: ['suspended', 'closing'],
  suspended: ['open', 'closing', 'cancelled'],
  closing: ['closed'],
  closed: ['resolution_pending'],
  resolution_pending: ['proposed', 'disputed', 'voided'],
  proposed: ['resolved', 'disputed', 'voided'],
  disputed: ['appealed', 'proposed', 'voided'],
  appealed: ['proposed', 'voided'],
  resolved: ['settling'],
  settling: ['settled'],
  settled: ['archived'],
  cancelled: ['archived'],
  voided: ['settling'],
  archived: [],
};

export function canTransitionMarket(from: MarketStatus, to: MarketStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionMarket(from: MarketStatus, to: MarketStatus): MarketStatus {
  if (!canTransitionMarket(from, to)) {
    throw new Error(`Invalid market transition: ${from} -> ${to}`);
  }
  return to;
}

export function allowedMarketTransitions(from: MarketStatus): readonly MarketStatus[] {
  return transitions[from];
}
