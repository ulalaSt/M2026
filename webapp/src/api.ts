import { getInitData } from './telegram';
import type { Schema, DraftClient, CreatedClient } from './types';

function pickApiBase(): string {
  const q = new URLSearchParams(window.location.search).get('api');
  if (q === 'dev') return 'https://m2026-bot-dev.ulalaseit.workers.dev';
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://m2026-bot.ulalaseit.workers.dev';
}
const API_BASE = pickApiBase();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const initData = getInitData();
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

export const api = {
  getSchema: () => request<Schema>('/api/schema'),
  createClient: (draft: DraftClient) =>
    request<CreatedClient>('/api/clients', { method: 'POST', body: JSON.stringify(draft) }),
};
