import type {
  ApiEnvelope,
  AuthenticatedUser,
  Balance,
  CreateDeposit,
  CreateWithdrawal,
  Deposit,
  FeeQuote,
  Market,
  Order,
  OrderQuoteRequest,
  Page,
  PlaceOrder,
  Position,
  Withdrawal,
} from '@kynorix/contracts';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

const ACCESS_TOKEN_KEY = 'kynorix.access-token';
const REFRESH_TOKEN_KEY = 'kynorix.refresh-token';

function apiUrl(): string {
  const value = process.env.EXPO_PUBLIC_API_URL;
  if (!value) throw new Error('EXPO_PUBLIC_API_URL is required.');
  return value.replace(/\/$/, '');
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}

async function request<T>(path: string, init: RequestInit, allowRefresh: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${apiUrl()}${path}`, { ...init, headers });
  if (response.status === 401 && allowRefresh && (await rotateTokens())) {
    return request<T>(path, init, false);
  }
  const body = (await response.json()) as ApiEnvelope<T> & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    const error = new Error(body.error?.message ?? body.error?.code ?? `API ${response.status}`);
    Object.assign(error, { status: response.status, code: body.error?.code });
    throw error;
  }
  return body.data;
}

let refreshOperation: Promise<boolean> | undefined;

async function rotateTokens(): Promise<boolean> {
  refreshOperation ??= performTokenRotation().finally(() => {
    refreshOperation = undefined;
  });
  return refreshOperation;
}

async function performTokenRotation(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  const issuer = process.env.EXPO_PUBLIC_OIDC_ISSUER;
  const clientId = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID;
  if (!refreshToken || !issuer || !clientId) return false;
  try {
    const discovery = await AuthSession.fetchDiscoveryAsync(issuer);
    const tokens = await AuthSession.refreshAsync(
      { clientId, refreshToken, scopes: ['openid', 'profile', 'email', 'offline_access'] },
      discovery,
    );
    if (!tokens.accessToken) return false;
    await mobileApi.saveTokens(tokens.accessToken, tokens.refreshToken ?? refreshToken);
    return true;
  } catch {
    await mobileApi.clearTokens();
    return false;
  }
}

export const mobileApi = {
  markets: () => api<Page<Market>>('/v1/markets?limit=50'),
  me: () => api<AuthenticatedUser>('/v1/me'),
  balances: () => api<Balance[]>('/v1/balances'),
  positions: () => api<Position[]>('/v1/positions'),
  orders: () => api<Order[]>('/v1/orders'),
  deposits: () => api<Deposit[]>('/v1/deposits'),
  withdrawals: () => api<Withdrawal[]>('/v1/withdrawals'),
  createDeposit: (input: CreateDeposit) =>
    api<unknown>('/v1/deposits', { method: 'POST', body: JSON.stringify(input) }),
  createWithdrawal: (input: CreateWithdrawal) =>
    api<Withdrawal>('/v1/withdrawals', { method: 'POST', body: JSON.stringify(input) }),
  quoteOrder: (input: OrderQuoteRequest) =>
    api<FeeQuote>('/v1/orders/quote', { method: 'POST', body: JSON.stringify(input) }),
  placeOrder: (input: PlaceOrder) =>
    api<Order>('/v1/orders', { method: 'POST', body: JSON.stringify(input) }),
  saveTokens: async (accessToken: string, refreshToken?: string) => {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (refreshToken) {
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
  },
  clearTokens: () =>
    Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    ]),
  hasSession: async () => Boolean(await SecureStore.getItemAsync(ACCESS_TOKEN_KEY)),
};
