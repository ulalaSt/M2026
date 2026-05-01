import { Context, InlineKeyboard } from 'grammy';
import { Client as NotionClient } from '@notionhq/client';
import { getSchema } from './schema';
import { parseIntent, AIIntent, formatUsage, Usage, ChatMsg, extractPhoneFromText } from './ai';
import {
  findClientsByPhone,
  updateClientPage,
  updatePositionPage,
  addPositionToClient,
  archivePosition,
  searchClientsUpcoming,
  searchClientsByDateRange,
  loadClientPositions,
  FoundClient,
  FoundPosition,
} from './notion';
import {
  Session,
  PendingEdit,
  PendingOp,
  emptySession,
  getSession,
  saveSession,
  clearSession,
} from './session';

type Env = {
  kv: KVNamespace;
  notion: NotionClient;
  anthropicKey: string;
};

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function formatClient(c: FoundClient): string {
  const lines: string[] = [];
  lines.push(`📞 ${c.phone}`);
  if (c.school) lines.push(`🏫 ${c.school}`);
  if (c.date) lines.push(`📅 ${fmtDate(c.date)}`);
  if (c.status) lines.push(`🚦 ${c.status}`);
  if (typeof c.paid === 'number') lines.push(`💰 Оплачено: ${c.paid} тг`);
  if (c.note) lines.push(`💬 ${c.note}`);
  if (c.positions.length) {
    lines.push(`📦 Позиции:`);
    for (const p of c.positions) lines.push(`  • ${formatPos(p)}`);
  }
  return lines.join('\n');
}

function formatPos(p: { color?: string; size?: string; kind?: string; qty?: number }): string {
  return `${p.color ?? '?'} ${p.size ?? '?'} ${p.kind ?? '?'} ×${p.qty ?? '?'}`;
}

function totalQty(positions: FoundPosition[]): number {
  return positions.reduce((s, p) => s + (p.qty ?? 0), 0);
}

function daysUntil(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function formatFullCard(c: FoundClient): string {
  const lines: string[] = [];
  lines.push(`📞 ${c.phone}`);
  if (c.status) lines.push(`🚦 ${c.status}`);
  if (c.date) {
    const d = daysUntil(c.date);
    const tail = d === 0 ? ' (сегодня)' : d > 0 ? ` (через ${d} дн)` : ` (${-d} дн назад)`;
    lines.push(`📅 ${c.date}${tail}`);
  }
  if (c.school) lines.push(`🏫 ${c.school}`);
  if (typeof c.price === 'number') lines.push(`💵 Цена: ${c.price} тг`);
  if (typeof c.paid === 'number') lines.push(`💰 Оплачено: ${c.paid} тг`);
  if (typeof c.discount === 'number') lines.push(`🏷 Скидка: ${c.discount} тг`);
  if (c.note) lines.push(`💬 ${c.note}`);
  if (c.positions.length) {
    lines.push(`📦 Позиции:`);
    for (const p of c.positions) lines.push(`  • ${formatPos(p)}`);
  }
  const t = totalQty(c.positions);
  if (typeof c.price === 'number' && t > 0) {
    const remaining = c.price * t - (c.paid ?? 0) - (c.discount ?? 0);
    lines.push(`💸 Остаток: ${remaining} тг`);
  }
  return lines.join('\n');
}

function formatReceipt(c: FoundClient): string {
  const lines: string[] = [];
  lines.push(`🧾 Чек по заказу`);
  lines.push(`📞 ${c.phone}`);
  if (c.school) lines.push(`🏫 ${c.school}`);
  if (c.date) lines.push(`📅 Дата выдачи: ${c.date}`);
  lines.push('');
  lines.push(`📦 Позиции:`);
  for (const p of c.positions) lines.push(`  • ${formatPos(p)}`);
  const t = totalQty(c.positions);
  const price = c.price ?? 0;
  const sum = price * t;
  lines.push('');
  lines.push(`Всего: ${t} шт × ${price} тг = ${sum} тг`);
  if (c.discount) lines.push(`🏷 Скидка: −${c.discount} тг`);
  if (c.paid) lines.push(`💰 Оплачено: −${c.paid} тг`);
  const remaining = sum - (c.paid ?? 0) - (c.discount ?? 0);
  lines.push(`💸 К оплате: ${remaining} тг`);
  return lines.join('\n');
}

async function handleShowOrders(
  ctx: Context,
  env: Env,
  intent: Extract<AIIntent, { intent: 'show_orders' }>,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let clients: FoundClient[];
  let header = '';
  if (intent.startDate && intent.endDate) {
    const summaries = await searchClientsByDateRange(env.notion, intent.startDate, intent.endDate);
    clients = await Promise.all(summaries.map(async s => ({
      ...s,
      address: undefined,
      positions: await loadClientPositions(env.notion, s.pageId).then(arr => arr.map((p, i) => ({ ...p, pageId: '' }))),
    })));
    header = `📅 ${intent.startDate === intent.endDate ? intent.startDate : `${intent.startDate} — ${intent.endDate}`}`;
  } else {
    const start = intent.startDate ?? today;
    const limit = intent.limit ?? 10;
    const summaries = await searchClientsUpcoming(env.notion, start, limit);
    clients = await Promise.all(summaries.map(async s => ({
      ...s,
      address: undefined,
      positions: await loadClientPositions(env.notion, s.pageId).then(arr => arr.map((p, i) => ({ ...p, pageId: '' }))),
    })));
    header = `📅 Ближайшие ${clients.length} (с ${start})`;
  }
  if (clients.length === 0) {
    await ctx.reply(`${header}\nЗаказов нет.`);
    return;
  }
  const colorKindTotals = new Map<string, number>();
  let totalPaid = 0;
  let totalSum = 0;
  for (const c of clients) {
    const q = totalQty(c.positions);
    if (typeof c.price === 'number') totalSum += c.price * q;
    if (typeof c.paid === 'number') totalPaid += c.paid;
    for (const p of c.positions) {
      if (!p.color || !p.kind || !p.qty) continue;
      const key = `${p.color} ${p.kind}`;
      colorKindTotals.set(key, (colorKindTotals.get(key) ?? 0) + p.qty);
    }
  }
  const out: string[] = [];
  out.push(header);
  out.push(`📦 Заказов: ${clients.length}`);
  if (colorKindTotals.size) {
    out.push('🎨 Итого:');
    for (const [k, q] of colorKindTotals) out.push(`   • ${k} ×${q}`);
  }
  out.push(`💰 Оплачено: ${totalPaid} тг`);
  out.push(`💵 Сумма: ${totalSum} тг`);
  out.push('');
  for (const c of clients) {
    const head: string[] = [c.phone];
    if (c.school) head.push(c.school);
    if (c.date) head.push(c.date);
    if (c.status) head.push(c.status);
    out.push('— ' + head.join(' · '));
    for (const p of c.positions) out.push(`   • ${formatPos(p)}`);
  }
  await ctx.reply(out.join('\n').slice(0, 4000));
}

const KIND_CODE: Record<string, string> = {
  'Взрослый': 'В',
  'Детский': 'Д',
  'Садик': 'Сад',
};

function colorPartFromLabel(label: string): string {
  // Берём всё до первого "-" и убираем пробелы: "🍇 Бд-15M" → "🍇Бд"
  const idx = label.indexOf('-');
  const head = idx > 0 ? label.slice(0, idx) : label;
  return head.replace(/\s+/g, '');
}

function compactPos(p: FoundPosition): string {
  const colorPart = p.label ? colorPartFromLabel(p.label) : (p.color ?? '?').split(/\s+/)[0];
  const kindCode = KIND_CODE[p.kind ?? ''] ?? p.kind?.[0] ?? '?';
  return `${colorPart} ${kindCode}-${p.qty ?? '?'}${p.size ?? ''}`;
}

function colorEmoji(p: FoundPosition): string {
  if (p.label) {
    const idx = p.label.indexOf('-');
    const head = idx > 0 ? p.label.slice(0, idx) : p.label;
    return head.split(/\s+/)[0];
  }
  return (p.color ?? '?').split(/\s+/)[0];
}

/** Группирует позиции по цвету+виду, выдаёт строку вида "🟢 В-15M-4S Д-1M 🍇 В-12M" */
function combinePositions(positions: FoundPosition[]): string {
  const byColor = new Map<string, Map<string, { size?: string; qty: number }[]>>();
  const colorOrder: string[] = [];
  for (const p of positions) {
    if (!p.qty) continue;
    const color = colorEmoji(p);
    if (!byColor.has(color)) {
      byColor.set(color, new Map());
      colorOrder.push(color);
    }
    const kindMap = byColor.get(color)!;
    const kindCode = KIND_CODE[p.kind ?? ''] ?? p.kind?.[0] ?? '?';
    if (!kindMap.has(kindCode)) kindMap.set(kindCode, []);
    kindMap.get(kindCode)!.push({ size: p.size, qty: p.qty });
  }
  const parts: string[] = [];
  for (const color of colorOrder) {
    const kindMap = byColor.get(color)!;
    const segs: string[] = [];
    for (const [kind, items] of kindMap) {
      const seg = kind + items.map(i => `-${i.qty}${i.size ?? ''}`).join('');
      segs.push(seg);
    }
    parts.push(`${color} ${segs.join(' ')}`);
  }
  return parts.join(' ');
}

function shortClientId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

function fmtDayShort(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

async function handleShowTimeline(ctx: Context, env: Env, startISO: string, endISO: string): Promise<void> {
  const summaries = await searchClientsByDateRange(env.notion, startISO, endISO);
  const clients: FoundClient[] = await Promise.all(summaries.map(async s => ({
    ...s,
    address: undefined,
    positions: await loadClientPositions(env.notion, s.pageId).then(arr => arr.map(p => ({ ...p, pageId: '' }))),
  })));
  // group by date
  const byDate = new Map<string, FoundClient[]>();
  for (const c of clients) {
    if (!c.date) continue;
    const arr = byDate.get(c.date) ?? [];
    arr.push(c);
    byDate.set(c.date, arr);
  }
  // iterate days from startISO to endISO
  const out: string[] = [`📅 Таймлайн ${fmtDayShort(startISO)} — ${fmtDayShort(endISO)}`, ''];
  const start = new Date(startISO + 'T00:00:00');
  const end = new Date(endISO + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const day = fmtDayShort(iso);
    const list = byDate.get(iso) ?? [];
    if (list.length === 0) {
      out.push(day);
      continue;
    }
    const parts = list.map(c => `N${shortClientId(c.phone)}→${combinePositions(c.positions)}`);
    out.push(`${day} ${parts.join('  ')}`);
  }
  // chunk by 4000 chars
  const text = out.join('\n');
  for (let i = 0; i < text.length; i += 3900) {
    await ctx.reply(text.slice(i, i + 3900));
  }
}


const THREAD_TTL_MS = 5 * 60 * 1000;

function buildClientContext(c: FoundClient): string {
  const lines: string[] = [];
  lines.push(`Телефон: ${c.phone}`);
  if (c.school) lines.push(`Школа: ${c.school}`);
  if (c.date) lines.push(`Дата выдачи: ${c.date}`);
  if (c.status) lines.push(`Статус: ${c.status}`);
  if (typeof c.price === 'number') lines.push(`Цена: ${c.price}`);
  if (typeof c.paid === 'number') lines.push(`Оплачено: ${c.paid}`);
  if (typeof c.discount === 'number') lines.push(`Скидка: ${c.discount}`);
  if (c.note) lines.push(`Примечание: ${c.note}`);
  if (c.positions.length) {
    lines.push(`Позиции (${c.positions.length}):`);
    for (const p of c.positions) {
      lines.push(`  - id=${p.pageId} ${p.color ?? '?'} ${p.size ?? '?'} ${p.kind ?? '?'} ×${p.qty ?? '?'}`);
    }
  }
  return lines.join('\n');
}

export async function handleAIMessage(ctx: Context, env: Env, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(env.kv, userId);
  const thread = session.aiThread;
  const history: ChatMsg[] = thread && thread.expiresAt > Date.now() ? thread.messages : [];

  try {
    const schema = await getSchema(env.notion, env.kv);

    // Pre-fetch: только при старте треда (чтобы не дёргать Notion на каждое уточнение)
    let prefetchedClient: FoundClient | undefined;
    let clientContext: string | undefined;
    if (history.length === 0) {
      const phone = extractPhoneFromText(text);
      if (phone) {
        const candidates = await findClientsByPhone(env.notion, phone);
        if (candidates.length === 1) {
          prefetchedClient = candidates[0];
          clientContext = buildClientContext(prefetchedClient);
        }
      }
    }

    const r = await parseIntent(env.anthropicKey, text, schema, history, clientContext);
    const usageLine = formatUsage(r.usage);

    if (r.kind === 'question') {
      const newMessages: ChatMsg[] = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: r.text },
      ];
      session.aiThread = { messages: newMessages, expiresAt: Date.now() + THREAD_TTL_MS };
      await saveSession(env.kv, userId, session);
      await ctx.reply(`💬 ${r.text}\n\n${usageLine}`);
      return;
    }

    // actions — чистим thread
    if (session.aiThread) {
      delete session.aiThread;
      await saveSession(env.kv, userId, session);
    }
    return handleParsedActions(ctx, env, r.actions, usageLine, prefetchedClient);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка AI: ${err?.message ?? err}`);
  }
}

export async function handleParsedActions(
  ctx: Context,
  env: Env,
  actions: AIIntent[],
  usageLine: string,
  prefetched?: FoundClient,
): Promise<void> {
  // Сначала разбираем show / unclear (read-only) — выводим сразу, не накапливаем
  for (const a of actions) {
    if (a.intent === 'unclear') {
      await ctx.reply(`🤔 Не понял: ${a.reason}\n\n${usageLine}`);
      return;
    }
  }

  const showActions = actions.filter(a => a.intent === 'show_client' || a.intent === 'show_orders' || a.intent === 'show_timeline');
  for (const a of showActions) {
    if (a.intent === 'show_orders') await handleShowOrders(ctx, env, a);
    else if (a.intent === 'show_timeline') await handleShowTimeline(ctx, env, a.startDate, a.endDate);
    else if (a.intent === 'show_client') {
      const clients = await findClientsByPhone(env.notion, a.phone);
      if (clients.length === 0) { await ctx.reply(`❌ Клиент с номером ${a.phone} не найден.`); continue; }
      if (clients.length > 1) { await ctx.reply(`❌ Несколько клиентов (${clients.length}). Уточни.`); continue; }
      const c = clients[0];
      const body = a.mode === 'receipt' ? formatReceipt(c) : formatFullCard(c);
      await ctx.reply(body);
    }
  }

  const editActions = actions.filter(a =>
    a.intent === 'update_client' || a.intent === 'update_position' ||
    a.intent === 'add_position' || a.intent === 'delete_position');

  if (editActions.length === 0) {
    if (showActions.length > 0) await ctx.reply(usageLine);
    return;
  }

  // Если в actions телефон не указан, но есть prefetched клиент — подставляем его
  if (prefetched) {
    for (const a of editActions) {
      if (!(a as any).phone) (a as any).phone = prefetched.phone;
    }
  }
  const phones = new Set(editActions.map(a => (a as any).phone).filter(Boolean));
  if (phones.size === 0) {
    await ctx.reply(`❌ Не указан телефон клиента.\n\n${usageLine}`);
    return;
  }
  if (phones.size > 1) {
    await ctx.reply(`❌ Действия для разных клиентов в одном запросе пока не поддерживаются.\n\n${usageLine}`);
    return;
  }
  const phone = [...phones][0];

  let client: FoundClient;
  if (prefetched && prefetched.phone.replace(/\D/g, '').endsWith(phone.replace(/\D/g, ''))) {
    client = prefetched;
  } else {
    const clients = await findClientsByPhone(env.notion, phone);
    if (clients.length === 0) {
      await ctx.reply(`❌ Клиент с номером ${phone} не найден.\n\n${usageLine}`);
      return;
    }
    if (clients.length > 1) {
      await ctx.reply(`❌ Несколько клиентов (${clients.length}). Уточни.\n\n${usageLine}`);
      return;
    }
    client = clients[0];
  }

  // Собираем PendingOps + descriptions
  const ops: PendingOp[] = [];
  const descLines: string[] = [];
  let updateClientChanges: Record<string, any> = {};

  for (const a of editActions) {
    if (a.intent === 'update_client') {
      const ch: Record<string, any> = {};
      if (a.date !== undefined) { ch.date = a.date; descLines.push(`📅 Дата: ${fmtDate(client.date)} → ${fmtDate(a.date)}`); }
      if (a.status !== undefined) { ch.status = a.status; descLines.push(`🚦 Статус: ${client.status ?? '—'} → ${a.status}`); }
      if (a.school !== undefined) { ch.school = a.school; descLines.push(`🏫 Школа: ${client.school ?? '—'} → ${a.school}`); }
      if (a.note !== undefined) { ch.note = a.note; descLines.push(`💬 Примечание: ${client.note ?? '—'} → ${a.note}`); }
      if (typeof a.discount === 'number') { ch.discount = a.discount; descLines.push(`🏷 Скидка: ${client.discount ?? 0} → ${a.discount} тг`); }
      if (typeof a.setPaid === 'number') {
        ch.paid = a.setPaid;
        descLines.push(`💰 Оплачено: ${client.paid ?? 0} → ${a.setPaid} тг`);
      } else if (typeof a.addPaid === 'number') {
        const next = (client.paid ?? 0) + a.addPaid;
        ch.paid = next;
        descLines.push(`💰 Оплачено: ${client.paid ?? 0} → ${next} тг (+${a.addPaid})`);
      }
      // Notion: если приходит несколько update_client подряд, мерджим в один update_client op
      updateClientChanges = { ...updateClientChanges, ...ch };
    } else if (a.intent === 'update_position') {
      const pos = client.positions.find(p => p.pageId === a.positionId);
      if (!pos) {
        await ctx.reply(`❌ Позиция id=${a.positionId} не найдена у клиента.`);
        return;
      }
      const ch: Record<string, any> = {};
      if (a.newColor) ch.color = a.newColor;
      if (a.newSize) ch.size = a.newSize;
      if (a.newKind) ch.kind = a.newKind;
      if (typeof a.newQty === 'number') ch.qty = a.newQty;
      ops.push({ type: 'update_position', positionPageId: pos.pageId, changes: ch });
      const after = formatPos({
        color: a.newColor ?? pos.color,
        size: a.newSize ?? pos.size,
        kind: a.newKind ?? pos.kind,
        qty: a.newQty ?? pos.qty,
      });
      descLines.push(`✏ ${formatPos(pos)} → ${after}`);
    } else if (a.intent === 'add_position') {
      ops.push({ type: 'add_position', pos: { color: a.color, size: a.size, kind: a.kind, qty: a.qty } });
      descLines.push(`➕ Позиция: ${a.color} ${a.size} ${a.kind} ×${a.qty}`);
    } else if (a.intent === 'delete_position') {
      const pos = client.positions.find(p => p.pageId === a.positionId);
      if (!pos) {
        await ctx.reply(`❌ Позиция id=${a.positionId} не найдена у клиента.`);
        return;
      }
      ops.push({ type: 'archive_position', positionPageId: pos.pageId });
      descLines.push(`🗑 Удалить: ${formatPos(pos)}`);
    }
  }

  if (Object.keys(updateClientChanges).length > 0) {
    ops.unshift({ type: 'update_client', changes: updateClientChanges });
  }

  if (ops.length === 0) {
    await ctx.reply(`❌ Нет применимых изменений.\n\n${usageLine}`);
    return;
  }

  // Защита: мержим дубликаты позиций по (color,size,kind) — AI не всегда видит это.
  const merged = mergeDuplicatePositions(client, ops, descLines);

  await saveAndPrompt(ctx, env, client, merged.descLines.join('\n'), usageLine, merged.ops);
}

/** Симулирует состояние позиций после ops и сливает дубликаты по (color,size,kind). */
function mergeDuplicatePositions(
  client: FoundClient,
  ops: PendingOp[],
  descLines: string[],
): { ops: PendingOp[]; descLines: string[] } {
  type Virt = { pageId?: string; color?: string; size?: string; kind?: string; qty: number; isNew: boolean; archived: boolean };
  const virt: Virt[] = client.positions.map(p => ({
    pageId: p.pageId, color: p.color, size: p.size, kind: p.kind, qty: p.qty ?? 0, isNew: false, archived: false,
  }));
  for (const op of ops) {
    if (op.type === 'update_position') {
      const v = virt.find(x => x.pageId === op.positionPageId);
      if (v) {
        if ('color' in op.changes) v.color = op.changes.color;
        if ('size' in op.changes) v.size = op.changes.size;
        if ('kind' in op.changes) v.kind = op.changes.kind;
        if ('qty' in op.changes) v.qty = op.changes.qty;
      }
    } else if (op.type === 'archive_position') {
      const v = virt.find(x => x.pageId === op.positionPageId);
      if (v) v.archived = true;
    } else if (op.type === 'add_position') {
      virt.push({ ...op.pos, qty: op.pos.qty ?? 0, isNew: true, archived: false });
    }
  }
  // Группируем активные по (color,size,kind)
  const groups = new Map<string, Virt[]>();
  for (const v of virt) {
    if (v.archived) continue;
    const key = `${v.color}|${v.size}|${v.kind}`;
    const arr = groups.get(key) ?? [];
    arr.push(v);
    groups.set(key, arr);
  }
  let mergedAny = false;
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    mergedAny = true;
    // Оставляем одну существующую (или первую) как «основную», остальные сливаем в неё
    arr.sort((a, b) => Number(a.isNew) - Number(b.isNew)); // существующие первыми
    const main = arr[0];
    const sumQty = arr.reduce((s, v) => s + v.qty, 0);
    main.qty = sumQty;
    for (let i = 1; i < arr.length; i++) arr[i].archived = true;
  }
  if (!mergedAny) return { ops, descLines };
  // Перестраиваем ops из virt
  const newOps: PendingOp[] = [];
  // обновления для существующих
  for (const v of virt) {
    if (!v.pageId) continue;
    const orig = client.positions.find(p => p.pageId === v.pageId)!;
    if (v.archived) {
      newOps.push({ type: 'archive_position', positionPageId: v.pageId });
      continue;
    }
    const ch: Record<string, any> = {};
    if (v.color !== orig.color) ch.color = v.color;
    if (v.size !== orig.size) ch.size = v.size;
    if (v.kind !== orig.kind) ch.kind = v.kind;
    if (v.qty !== (orig.qty ?? 0)) ch.qty = v.qty;
    if (Object.keys(ch).length) newOps.push({ type: 'update_position', positionPageId: v.pageId, changes: ch });
  }
  // новые
  for (const v of virt) {
    if (v.pageId || v.archived) continue;
    if (!v.color || !v.size || !v.kind) continue;
    newOps.push({ type: 'add_position', pos: { color: v.color, size: v.size, kind: v.kind, qty: v.qty } });
  }
  // Сохраняем update_client как был
  const clientOp = ops.find(o => o.type === 'update_client');
  if (clientOp) newOps.unshift(clientOp);
  // Описание изменилось — добавляем пометку
  return {
    ops: newOps,
    descLines: [...descLines, '🔀 Дубликаты позиций объединены автоматически'],
  };
}

export async function handleParsedIntent(ctx: Context, env: Env, intent: AIIntent, usageLine: string, prefetched?: FoundClient): Promise<void> {
  return handleParsedActions(ctx, env, [intent], usageLine, prefetched);
}

async function saveAndPrompt(
  ctx: Context,
  env: Env,
  client: FoundClient,
  description: string,
  usageLine: string | undefined,
  operations: PendingOp[],
): Promise<void> {
  const userId = ctx.from!.id;
  const session = emptySession();
  session.step = 'edit_confirm';
  session.pendingEdit = {
    clientPageId: client.pageId,
    description,
    operations,
    usageLine,
  };
  await saveSession(env.kv, userId, session);
  const kb = new InlineKeyboard()
    .text('✅ Применить', 'edit:apply')
    .text('❌ Отмена', 'edit:cancel');
  const tail = usageLine ? `\n\n${usageLine}` : '';
  await ctx.reply(
    `Текущий клиент:\n${formatClient(client)}\n\nИзменения:\n${description}${tail}`,
    { reply_markup: kb },
  );
}

export async function applyPendingEdit(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(env.kv, userId);
  const pe = session.pendingEdit;
  if (!pe) {
    await ctx.reply('Нет ожидающих изменений.');
    return;
  }
  try {
    for (const op of pe.operations) {
      if (op.type === 'update_client') {
        await updateClientPage(env.notion, pe.clientPageId, op.changes);
      } else if (op.type === 'update_position') {
        await updatePositionPage(env.notion, op.positionPageId, op.changes);
      } else if (op.type === 'add_position') {
        await addPositionToClient(env.notion, pe.clientPageId, op.pos);
      } else if (op.type === 'archive_position') {
        await archivePosition(env.notion, op.positionPageId);
      }
    }
    await clearSession(env.kv, userId);
    const tail = pe.usageLine ? `\n${pe.usageLine}` : '';
    await ctx.reply(`✅ Применено: ${pe.description}${tail}`);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка применения: ${err?.message ?? err}`);
  }
}

export async function cancelPendingEdit(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  await clearSession(env.kv, userId);
  await ctx.reply('Отменено.');
}

// pickPosition больше не нужен — AI ссылается на позиции по индексам напрямую.
// Оставим заглушку чтобы не ломать импорты в flow.ts при наличии стейл-сессий.
export async function pickPosition(ctx: Context, env: Env, _positionPageId: string): Promise<void> {
  await clearSession(env.kv, ctx.from!.id);
  await ctx.reply('Сессия устарела — повтори запрос.');
}
