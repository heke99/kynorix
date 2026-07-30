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
} from '@zoryqon/contracts';
import * as SecureStore from 'expo-secure-store';

const ACCESS_TOKEN_KEY = 'zoryqon.access-token';
const REFRESH_TOKEN_KEY = 'zoryqon.refresh-token';

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
  if (!refreshToken) return false;
  try {
    const tokens = await supabaseAuth('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    });
    if (!tokens.access_token) return false;
    await mobileApi.saveTokens(tokens.access_token, tokens.refresh_token ?? refreshToken);
    return true;
  } catch {
    await mobileApi.clearTokens();
    return false;
  }
}

async function supabaseAuth(
  path: string,
  body: Record<string, unknown>,
): Promise<{ access_token?: string; refresh_token?: string; message?: string; error_description?: string }> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase mobile authentication is not configured.');
  const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    message?: string;
    error_description?: string;
  };
  if (!response.ok) throw new Error(payload.error_description ?? payload.message ?? 'Login failed.');
  return payload;
}

export const mobileApi = {
  signIn: async (email: string, password: string) => {
    const tokens = await supabaseAuth('/auth/v1/token?grant_type=password', {
      email: email.trim().toLowerCase(),
      password,
    });
    if (!tokens.access_token || !tokens.refresh_token) throw new Error('Login returned no session.');
    await mobileApi.saveTokens(tokens.access_token, tokens.refresh_token);
  },
  signUp: async (email: string, password: string, displayName: string) => {
    const tokens = await supabaseAuth('/auth/v1/signup', {
      email: email.trim().toLowerCase(),
      password,
      data: { display_name: displayName.trim() },
    });
    if (tokens.access_token && tokens.refresh_token) {
      await mobileApi.saveTokens(tokens.access_token, tokens.refresh_token);
      return { confirmationRequired: false };
    }
    return { confirmationRequired: true };
  },
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
