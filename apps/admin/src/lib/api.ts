import type { ApiEnvelope, Market, ProposeResolution } from '@kynorix/contracts';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function adminApi<T>(path: string, officerRef: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-kynorix-admin': officerRef,
      ...init?.headers,
    },
    cache: 'no-store',
  });
  const body = (await response.json()) as ApiEnvelope<T> & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? body.error?.code ?? 'API-fel');
  return body.data;
}

export const operationsApi = {
  markets: async () => {
    const response = await fetch(`${API_URL}/v1/markets`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Marknaderna kunde inte hämtas');
    return ((await response.json()) as ApiEnvelope<Market[]>).data;
  },
  capabilities: async () => {
    const response = await fetch(`${API_URL}/v1/system/capabilities`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Systemstatus kunde inte hämtas');
    return (
      (await response.json()) as ApiEnvelope<{
        release: string;
        sandbox: boolean;
        enabled: string[];
        denied: string[];
        policyEnforcement: string;
      }>
    ).data;
  },
  closeForResolution: (marketRef: string, officerRef: string) =>
    adminApi<Market>(`/v1/admin/markets/${marketRef}/close-for-resolution`, officerRef, {
      method: 'POST',
      body: '{}',
    }),
  proposeResolution: (marketRef: string, officerRef: string, proposal: ProposeResolution) =>
    adminApi<{ proposalRef: string }>(`/v1/admin/markets/${marketRef}/resolutions`, officerRef, {
      method: 'POST',
      body: JSON.stringify(proposal),
    }),
  approveResolution: (proposalRef: string, officerRef: string) =>
    adminApi<{ market: Market }>(`/v1/admin/resolutions/${proposalRef}/approve`, officerRef, {
      method: 'POST',
      body: '{}',
    }),
};
