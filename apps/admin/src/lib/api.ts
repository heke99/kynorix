import type {
  ApiEnvelope,
  AuthenticatedUser,
  CreateMarket,
  Market,
  Page,
  ProposeResolution,
} from '@zoryqon/contracts';

function apiUrl(): string {
  const value = configuredApiUrl();
  if (!value) throw new Error('NEXT_PUBLIC_API_URL is required.');
  return value;
}

function configuredApiUrl(): string | null {
  const value =
    process.env.NEXT_PUBLIC_API_URL ??
    (process.env.NODE_ENV === 'development' ? 'http://localhost:4000' : undefined);
  return value ? value.replace(/\/$/, '') : null;
}

export async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init, true);
}

async function request<T>(path: string, init: RequestInit | undefined, allowRefresh: boolean): Promise<T> {
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
  if (response.status === 401 && allowRefresh && !path.startsWith('/v1/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed) return request<T>(path, init, false);
  }
  const body = (await response.json()) as ApiEnvelope<T> & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    const error = new Error(body.error?.message ?? body.error?.code ?? 'API request failed.');
    Object.assign(error, { status: response.status, code: body.error?.code });
    throw error;
  }
  return body.data;
}

async function refreshSession(): Promise<boolean> {
  const headers = new Headers({ 'content-type': 'application/json' });
  const csrf = readCookie('zoryqon_csrf');
  if (csrf) headers.set('x-csrf-token', csrf);
  try {
    const response = await fetch(`${apiUrl()}/v1/auth/refresh`, {
      method: 'POST',
      headers,
      credentials: 'include',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const operationsApi = {
  me: () => adminApi<AuthenticatedUser>('/v1/me'),
  loginUrl: () => '/login',
  overview: () =>
    adminApi<{
      open_markets: string;
      pending_resolutions: string;
      pending_withdrawals: string;
      open_compliance_cases: string;
      ledger_difference_count: string;
      critical_reconciliation_cases: string;
    }>('/v1/admin/overview'),
  markets: () => adminApi<Page<Market>>('/v1/admin/markets?limit=100'),
  createMarket: (input: CreateMarket) =>
    adminApi<Market>('/v1/admin/markets', { method: 'POST', body: JSON.stringify(input) }),
  transition: (marketRef: string, action: string, reason: string) =>
    adminApi<Market>(`/v1/admin/markets/${encodeURIComponent(marketRef)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  proposeResolution: (marketRef: string, proposal: ProposeResolution) =>
    adminApi<{ proposalRef: string }>(
      `/v1/admin/markets/${encodeURIComponent(marketRef)}/resolution`,
      { method: 'POST', body: JSON.stringify(proposal) },
    ),
  approveResolution: (proposalRef: string, reason: string) =>
    adminApi<{ market: Market }>(
      `/v1/admin/resolutions/${encodeURIComponent(proposalRef)}/approve`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  records: (path: string) => adminApi<Array<Record<string, unknown>>>(`/v1/admin/${path}`),
};

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
