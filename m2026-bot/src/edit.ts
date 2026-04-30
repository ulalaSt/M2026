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

async function handleUpdatePositions(
  ctx: Context,
  env: Env,
  client: FoundClient,
  intent: Extract<AIIntent, { intent: 'update_positions' }>,
  usageLine?: string,
): Promise<void> {
  const userId = ctx.from!.id;
  if (client.positions.length === 0) {
    await ctx.reply(`❌ У клиента ${client.phone} нет позиций.`);
    return;
  }
  const matched = intent.match
    ? matchPositions(client.positions, intent.match)
    : client.positions.slice();
  if (matched.length === 0) {
    await ctx.reply(`❌ Не нашёл позиции по фильтру: ${formatPos(intent.match ?? {})}`);
    return;
  }

  // Split-режим: одна исходная позиция, отщепляем splitQty
  if (intent.splitQty && intent.splitQty > 0) {
    if (matched.length > 1) {
      // показать picker
      const session = emptySession();
      session.step = 'edit_pick_position';
      session.positionCandidates = matched.map(m => ({ positionPageId: m.pageId, label: formatPos(m) }));
      session.pendingChange = {
        type: 'update_positions',
        phone: client.phone,
        match: intent.match ?? {},
        newColor: intent.newColor,
        newSize: intent.newSize,
        newKind: intent.newKind,
        splitQty: intent.splitQty,
      };
      session.selectedPageId = client.pageId;
      await saveSession(env.kv, userId, session);
      const kb = new InlineKeyboard();
      for (const m of matched) kb.text(`✏ ${formatPos(m)}`, `pickpos:${m.pageId}`).row();
      kb.text('❌ Отмена', 'pickpos:cancel');
      await ctx.reply(`Несколько подходящих позиций. Выбери одну:\n\n${formatClient(client)}\n\n${usageLine}`, { reply_markup: kb });
      return;
    }
    const src = matched[0];
    if ((src.qty ?? 0) < intent.splitQty) {
      await ctx.reply(`❌ В «${formatPos(src)}» только ${src.qty} шт.`);
      return;
    }
    const target = {
      color: intent.newColor ?? src.color,
      size: intent.newSize ?? src.size,
      kind: intent.newKind ?? src.kind,
    };
    const dest = client.positions.find(p =>
      p.pageId !== src.pageId &&
      p.color === target.color && p.size === target.size && p.kind === target.kind,
    );
    const remaining = (src.qty ?? 0) - intent.splitQty;
    const ops: PendingOp[] = [];
    if (remaining === 0) ops.push({ type: 'archive_position', positionPageId: src.pageId });
    else ops.push({ type: 'update_position', positionPageId: src.pageId, changes: { qty: remaining } });
    if (dest) {
      ops.push({ type: 'update_position', positionPageId: dest.pageId, changes: { qty: (dest.qty ?? 0) + intent.splitQty } });
    } else {
      if (!target.color || !target.size || !target.kind) {
        await ctx.reply('❌ Недостаточно данных для целевой позиции.');
        return;
      }
      ops.push({ type: 'add_position', pos: { color: target.color, size: target.size, kind: target.kind, qty: intent.splitQty } });
    }
    const srcAfter = remaining === 0 ? '(удалить)' : `${formatPos(src)} → ×${remaining}`;
    const destAfter = dest
      ? `${formatPos(dest)} → ×${(dest.qty ?? 0) + intent.splitQty}`
      : `создать ${target.color} ${target.size} ${target.kind} ×${intent.splitQty}`;
    const desc = `✏ Разделить ${intent.splitQty} шт:\n  • было: ${formatPos(src)}\n  • станет: ${srcAfter}\n  • перенос: ${destAfter}`;
    return saveAndPrompt(ctx, env, client, desc, usageLine, ops);
  }

  // Обычный режим: применяем set-поля ко всем matched
  const changes: Record<string, any> = {};
  if (intent.newColor) changes.color = intent.newColor;
  if (intent.newSize) changes.size = intent.newSize;
  if (intent.newKind) changes.kind = intent.newKind;
  if (typeof intent.newQty === 'number') changes.qty = intent.newQty;
  const ops: PendingOp[] = matched.map(p => ({
    type: 'update_position', positionPageId: p.pageId, changes,
  }));

  const fields = [
    intent.newColor && `цвет → ${intent.newColor}`,
    intent.newSize && `размер → ${intent.newSize}`,
    intent.newKind && `вид → ${intent.newKind}`,
    typeof intent.newQty === 'number' && `кол-во → ${intent.newQty}`,
  ].filter(Boolean).join(', ');
  const scope = intent.match
    ? `по фильтру (${matched.length})`
    : `все (${matched.length})`;
  const desc = `✏ Позиции ${scope}: ${fields}`;
  return saveAndPrompt(ctx, env, client, desc, usageLine, ops);
}

function matchPositions(positions: FoundPosition[], match: { color?: string; size?: string; kind?: string }): FoundPosition[] {
  return positions.filter(p =>
    (!match.color || p.color === match.color) &&
    (!match.size || p.size === match.size) &&
    (!match.kind || p.kind === match.kind),
  );
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
      lines.push(`  - ${p.color ?? '?'} ${p.size ?? '?'} ${p.kind ?? '?'} ×${p.qty ?? '?'}`);
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

    // intent — чистим thread
    if (session.aiThread) {
      delete session.aiThread;
      await saveSession(env.kv, userId, session);
    }
    return handleParsedIntent(ctx, env, r.intent, usageLine, prefetchedClient);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка AI: ${err?.message ?? err}`);
  }
}

export async function handleParsedIntent(ctx: Context, env: Env, intent: AIIntent, usageLine: string, prefetched?: FoundClient): Promise<void> {
  if (intent.intent === 'unclear') {
    await ctx.reply(`🤔 Не понял: ${intent.reason}\n\n${usageLine}`);
    return;
  }

  if (intent.intent === 'show_orders') {
    await handleShowOrders(ctx, env, intent);
    await ctx.reply(usageLine);
    return;
  }

  if (intent.intent === 'show_timeline') {
    await handleShowTimeline(ctx, env, intent.startDate, intent.endDate);
    await ctx.reply(usageLine);
    return;
  }

  if (!intent.phone) {
    await ctx.reply(`❌ Не указан телефон клиента в запросе.\n\n${usageLine}`);
    return;
  }

  if (intent.intent === 'show_client') {
    const clients = await findClientsByPhone(env.notion, intent.phone);
    if (clients.length === 0) { await ctx.reply(`❌ Клиент с номером ${intent.phone} не найден.\n\n${usageLine}`); return; }
    if (clients.length > 1) { await ctx.reply(`❌ Несколько клиентов (${clients.length}). Уточни номер.\n\n${usageLine}`); return; }
    const c = clients[0];
    const body = intent.mode === 'receipt' ? formatReceipt(c) : formatFullCard(c);
    await ctx.reply(`${body}\n\n${usageLine}`);
    return;
  }

  let client: FoundClient;
  if (prefetched && prefetched.phone.replace(/\D/g, '').endsWith(intent.phone.replace(/\D/g, ''))) {
    client = prefetched;
  } else {
    const clients = await findClientsByPhone(env.notion, intent.phone);
    if (clients.length === 0) {
      await ctx.reply(`❌ Клиент с номером ${intent.phone} не найден.\n\n${usageLine}`);
      return;
    }
    if (clients.length > 1) {
      await ctx.reply(`❌ Найдено несколько клиентов (${clients.length}) с похожим номером. Уточни.\n\n${usageLine}`);
      return;
    }
    client = clients[0];
  }
  await prepareEdit(ctx, env, client, intent, usageLine);
}

async function prepareEdit(ctx: Context, env: Env, client: FoundClient, intent: AIIntent, usageLine?: string): Promise<void> {
  const userId = ctx.from!.id;

  switch (intent.intent) {
    case 'change_date': {
      const desc = `📅 Дата: ${fmtDate(client.date)} → ${fmtDate(intent.newDate)}`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'update_client', changes: { date: intent.newDate } },
      ]);
    }
    case 'change_status': {
      const desc = `🚦 Статус: ${client.status ?? '—'} → ${intent.newStatus}`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'update_client', changes: { status: intent.newStatus } },
      ]);
    }
    case 'change_payment': {
      const cur = client.paid ?? 0;
      const next = intent.setPaid !== undefined ? intent.setPaid : cur + (intent.addPaid ?? 0);
      const desc = `💰 Оплачено: ${cur} → ${next} тг`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'update_client', changes: { paid: next } },
      ]);
    }
    case 'change_note': {
      const desc = `💬 Примечание: ${client.note ?? '—'} → ${intent.note}`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'update_client', changes: { note: intent.note } },
      ]);
    }
    case 'change_school': {
      const desc = `🏫 Уч. заведение: ${client.school ?? '—'} → ${intent.newSchool}`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'update_client', changes: { school: intent.newSchool } },
      ]);
    }
    case 'add_position': {
      const desc = `➕ Добавить: ${intent.color} ${intent.size} ${intent.kind} ×${intent.qty}`;
      return saveAndPrompt(ctx, env, client, desc, usageLine, [
        { type: 'add_position', pos: { color: intent.color, size: intent.size, kind: intent.kind, qty: intent.qty } },
      ]);
    }
    case 'update_positions': {
      return handleUpdatePositions(ctx, env, client, intent, usageLine);
    }
  }
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

export async function pickPosition(ctx: Context, env: Env, positionPageId: string): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(env.kv, userId);
  const pc = session.pendingChange;
  const candidates = session.positionCandidates ?? [];
  if (!pc || pc.type !== 'update_positions' || !session.selectedPageId) {
    await ctx.reply('Сессия истекла.');
    await clearSession(env.kv, userId);
    return;
  }
  const found = candidates.find(c => c.positionPageId === positionPageId);
  if (!found) {
    await ctx.reply('Позиция не найдена в выборке.');
    return;
  }
  const clients = await findClientsByPhone(env.notion, pc.phone);
  if (clients.length !== 1) {
    await ctx.reply('Клиент не найден.');
    await clearSession(env.kv, userId);
    return;
  }
  const client = clients[0];
  const intent: Extract<AIIntent, { intent: 'update_positions' }> = {
    intent: 'update_positions',
    phone: pc.phone,
    // фильтр сужаем до конкретной позиции через её атрибуты — после picker мы знаем точный pageId
    match: { color: undefined, size: undefined, kind: undefined },
    newColor: pc.newColor,
    newSize: pc.newSize,
    newKind: pc.newKind,
    newQty: pc.newQty,
    splitQty: pc.splitQty,
  };
  // ограничиваем positions до выбранной — переопределяем client locally
  const pos = client.positions.find(p => p.pageId === positionPageId);
  if (!pos) {
    await ctx.reply('Позиция не найдена.');
    await clearSession(env.kv, userId);
    return;
  }
  const localClient: FoundClient = { ...client, positions: [pos] };
  return handleUpdatePositions(ctx, env, localClient, { ...intent, match: undefined }, '');
}
