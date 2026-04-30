import { Client as NotionClient } from '@notionhq/client';
import { ALLOWED_USER_IDS } from './config';
import { getSchema } from './schema';
import { createClientWithPositions } from './notion';
import { DraftClient } from './session';

type ApiEnv = {
  kv: KVNamespace;
  notion: NotionClient;
  telegramBotToken: string;
};

const ALLOWED_ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)?m2026-webapp\.pages\.dev$/;

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGIN_PATTERN.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://m2026-webapp.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    'Vary': 'Origin',
  };
}

function jsonResponse(data: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function jsonError(status: number, message: string, origin: string | null): Response {
  return jsonResponse({ error: message }, origin, status);
}

export async function handleApi(request: Request, env: ApiEnv, url: URL): Promise<Response> {
  const origin = request.headers.get('Origin');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const initData = request.headers.get('X-Telegram-Init-Data');
  if (!initData) return jsonError(401, 'Missing X-Telegram-Init-Data', origin);

  const user = await verifyTelegramInitData(initData, env.telegramBotToken);
  if (!user) return jsonError(401, 'Invalid initData', origin);

  if (!ALLOWED_USER_IDS.includes(user.id)) {
    return jsonError(403, 'Not whitelisted', origin);
  }

  if (url.pathname === '/api/schema' && request.method === 'GET') {
    const schema = await getSchema(env.notion, env.kv);
    return jsonResponse(schema, origin);
  }

  if (url.pathname === '/api/clients' && request.method === 'POST') {
    let draft: DraftClient;
    try {
      draft = await request.json();
    } catch {
      return jsonError(400, 'Invalid JSON body', origin);
    }
    const validation = validateDraft(draft);
    if (validation) return jsonError(400, validation, origin);
    try {
      const result = await createClientWithPositions(env.notion, draft);
      return jsonResponse(result, origin);
    } catch (err: any) {
      return jsonError(500, `Notion error: ${err?.message ?? err}`, origin);
    }
  }

  return jsonError(404, 'Not found', origin);
}

function validateDraft(d: any): string | null {
  if (!d || typeof d !== 'object') return 'Body must be an object';
  if (!d.phone || typeof d.phone !== 'string') return 'phone is required';
  if (d.school !== undefined && typeof d.school !== 'string') return 'school must be a string';
  if (!d.date || typeof d.date !== 'string') return 'date is required';
  if (typeof d.price === 'number' && d.price < 0) return 'price must be >= 0';
  if (typeof d.paid === 'number' && d.paid < 0) return 'paid must be >= 0';
  if (!Array.isArray(d.positions) || d.positions.length === 0) return 'at least one position required';
  for (const p of d.positions) {
    if (!p?.color || !p?.size || !p?.kind || typeof p?.qty !== 'number' || p.qty <= 0) {
      return 'each position must have color, size, kind, qty > 0';
    }
  }
  return null;
}

// --- Telegram WebApp initData verification ---

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };

export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
): Promise<TelegramUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  // auth_date свежий (< 24 часа)
  const authDate = parseInt(params.get('auth_date') ?? '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  // data-check-string: остальные ключи отсортированы, key=value через \n
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = await hmac(new TextEncoder().encode('WebAppData'), botToken);
  // calc_hash = HMAC_SHA256(secret_key, data_check_string), hex
  const calcHash = await hmacHex(secretKey, dataCheckString);
  if (!safeEqual(calcHash, hash)) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson) as TelegramUser;
    if (!user.id) return null;
    return user;
  } catch {
    return null;
  }
}

async function hmac(keyBytes: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}

async function hmacHex(keyBytes: ArrayBuffer, data: string): Promise<string> {
  const sig = await hmac(keyBytes, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
