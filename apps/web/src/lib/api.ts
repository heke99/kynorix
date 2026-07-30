import type {
  ApiEnvelope,
  Balance,
  Market,
  Order,
  PlaceOrder,
  Position,
  Trade,
} from '@kynorix/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const DEMO_USER = 'demo-alex';

export async function api<T>(path: string, init?: RequestInit, authenticated = false): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (authenticated) headers.set('x-kynorix-user', DEMO_USER);
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
  const body = (await response.json()) as ApiEnvelope<T> & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? body.error?.code ?? 'API request failed');
  }
  return body.data;
}

export const kynorixApi = {
  markets: () => api<Market[]>('/v1/markets'),
  market: (marketRef: string) => api<Market>(`/v1/markets/${marketRef}`),
  orderbook: (marketRef: string, outcomeRef: string) =>
    api<{
      sequence: string;
      bids: Array<{ priceAtoms: string; quantity: string }>;
      asks: Array<{ priceAtoms: string; quantity: string }>;
    }>(`/v1/markets/${marketRef}/orderbook?outcomeRef=${encodeURIComponent(outcomeRef)}`),
  trades: (marketRef: string) => api<Trade[]>(`/v1/markets/${marketRef}/trades?limit=25`),
  placeOrder: (input: PlaceOrder) =>
    api<Order>('/v1/orders', { method: 'POST', body: JSON.stringify(input) }, true),
  cancelOrder: (orderRef: string) =>
    api<Order>(`/v1/orders/${orderRef}`, { method: 'DELETE' }, true),
  balances: () => api<Balance[]>('/v1/balances', undefined, true),
  positions: () => api<Position[]>('/v1/positions', undefined, true),
  orders: () => api<Order[]>('/v1/orders', undefined, true),
};

export function formatAtoms(value: string, currency = 'VSEK'): string {
  const amount = Number(value) / 100;
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: currency === 'VSEK' ? 'SEK' : currency,
    minimumFractionDigits: 2,
  })
    .format(amount)
    .replace('kr', currency === 'VSEK' ? 'VSEK' : 'kr');
}

export function formatProbability(value?: string): string {
  return value ? `${value}%` : '—';
}
