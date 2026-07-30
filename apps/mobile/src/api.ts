import type { ApiEnvelope, Balance, Market, Order, PlaceOrder } from '@kynorix/contracts';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

function defaultApiUrl(): string {
  if (Platform.OS === 'android') return 'http://10.0.2.2:4000';
  return 'http://localhost:4000';
}

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? defaultApiUrl();

async function api<T>(path: string, authenticated = false, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('x-kynorix-user', 'demo-alex');
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return ((await response.json()) as ApiEnvelope<T>).data;
}

export const mobileApi = {
  markets: () => api<Market[]>('/v1/markets'),
  balances: () => api<Balance[]>('/v1/balances', true),
  placeOrder: (input: PlaceOrder) =>
    api<Order>('/v1/orders', true, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  mode: () => ({
    mode: Constants.expoConfig?.extra?.productMode as string,
    realMoney: Constants.expoConfig?.extra?.realMoneyEnabled as boolean,
  }),
};
