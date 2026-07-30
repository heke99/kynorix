import type {
  ApiEnvelope,
  AuthenticatedUser,
  Balance,
  CreateDeposit,
  CreateWithdrawal,
  Deposit,
  FeeQuote,
  Market,
  MarketHistoryPoint,
  Order,
  OrderQuoteRequest,
  Page,
  PlaceOrder,
  Position,
  StartVerification,
  Trade,
  VerificationStatus,
  Withdrawal,
} from '@zoryqon/contracts';

function apiUrl(): string {
  const value = configuredApiUrl();
  if (!value) throw new Error('NEXT_PUBLIC_API_URL is required.');
  return value;
}

function configuredApiUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_API_URL;
  return value ? value.replace(/\/$/, '') : null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  const csrf = readCookie('zoryqon_csrf');
  if (csrf && init?.method && init.method !== 'GET') headers.set('x-csrf-token', csrf);
  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const body = (await response.json()) as ApiEnvelope<T> & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    const error = new Error(body.error?.message ?? body.error?.code ?? 'API request failed.');
    Object.assign(error, { code: body.error?.code, status: response.status });
    throw error;
  }
  return body.data;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export const zoryqonApi = {
  markets: (
    filters: {
      query?: string;
      category?: string;
      sort?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) => api<Page<Market>>(`/v1/markets${queryString(filters)}`),
  market: (marketRef: string) => api<Market>(`/v1/markets/${encodeURIComponent(marketRef)}`),
  categories: () => api<Array<{ categoryRef: string; name: string }>>('/v1/categories'),
  orderbook: (marketRef: string, outcomeRef: string) =>
    api<{
      sequence: string;
      bids: Array<{ priceAtoms: string; quantity: string }>;
      asks: Array<{ priceAtoms: string; quantity: string }>;
    }>(
      `/v1/markets/${encodeURIComponent(marketRef)}/orderbook?outcomeRef=${encodeURIComponent(outcomeRef)}`,
    ),
  trades: (marketRef: string) =>
    api<Trade[]>(`/v1/markets/${encodeURIComponent(marketRef)}/trades?limit=50`),
  history: (marketRef: string, outcomeRef: string, range = '1D') =>
    api<MarketHistoryPoint[]>(
      `/v1/markets/${encodeURIComponent(marketRef)}/history${queryString({ outcomeRef, range })}`,
    ),
  me: () => api<AuthenticatedUser>('/v1/me'),
  quoteOrder: (input: OrderQuoteRequest) =>
    api<FeeQuote>('/v1/orders/quote', { method: 'POST', body: JSON.stringify(input) }),
  placeOrder: (input: PlaceOrder) =>
    api<Order>('/v1/orders', { method: 'POST', body: JSON.stringify(input) }),
  cancelOrder: (orderRef: string) =>
    api<Order>(`/v1/orders/${encodeURIComponent(orderRef)}`, { method: 'DELETE' }),
  balances: () => api<Balance[]>('/v1/balances'),
  positions: () => api<Position[]>('/v1/positions'),
  orders: () => api<Order[]>('/v1/orders'),
  deposits: () => api<Deposit[]>('/v1/deposits'),
  createDeposit: (input: CreateDeposit) =>
    api<unknown>('/v1/deposits', { method: 'POST', body: JSON.stringify(input) }),
  withdrawals: () => api<Withdrawal[]>('/v1/withdrawals'),
  createWithdrawal: (input: CreateWithdrawal) =>
    api<Withdrawal>('/v1/withdrawals', { method: 'POST', body: JSON.stringify(input) }),
  confirmWithdrawal: (withdrawalRef: string, input: { idempotencyKey: string }) =>
    api<Withdrawal>(`/v1/withdrawals/${encodeURIComponent(withdrawalRef)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  verification: () => api<VerificationStatus>('/v1/verification'),
  startVerification: (input: StartVerification) =>
    api<VerificationStatus>('/v1/verification/start', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sessions: () =>
    api<
      Array<{
        sessionRef: string;
        deviceRef: string | null;
        ip: string | null;
        userAgent: string | null;
        mfaVerified: boolean;
        lastSeenAt: string;
        expiresAt: string;
        createdAt: string;
      }>
    >('/v1/sessions'),
  revokeSession: (sessionRef: string) =>
    api<{ revoked: boolean }>(`/v1/sessions/${encodeURIComponent(sessionRef)}`, {
      method: 'DELETE',
    }),
  notificationPreferences: () =>
    api<{
      emailEnabled: boolean;
      pushEnabled: boolean;
      inAppEnabled: boolean;
      securitySmsEnabled: boolean;
      marketClosingEnabled: boolean;
    }>('/v1/notification-preferences'),
  updateNotificationPreferences: (input: {
    emailEnabled: boolean;
    pushEnabled: boolean;
    inAppEnabled: boolean;
    securitySmsEnabled: boolean;
    marketClosingEnabled: boolean;
  }) =>
    api('/v1/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  logout: () => api<{ loggedOut: boolean }>('/v1/auth/logout', { method: 'POST' }),
  loginUrl: (returnTo = '/') => {
    const baseUrl = configuredApiUrl();
    return baseUrl
      ? `${baseUrl}/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`
      : '/support?error=identity-configuration-unavailable';
  },
  accountSecurityUrl: () =>
    process.env.NEXT_PUBLIC_OIDC_ACCOUNT_URL ??
    '/support?error=identity-account-management-unavailable',
};

export function formatAtoms(value: string, asset: string, decimals = 2): string {
  const amount = BigInt(value || '0');
  const base = 10n ** BigInt(decimals);
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, '0');
  return `${amount < 0n ? '-' : ''}${new Intl.NumberFormat('en-US').format(whole)}.${fraction} ${asset}`;
}

export function formatProbability(value?: string | null): string {
  return value ? `${value}%` : '—';
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}
