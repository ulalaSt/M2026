import { Context, InlineKeyboard } from 'grammy';
import { Client as NotionClient } from '@notionhq/client';
import { getSchema } from './schema';
import { parseIntent, AIIntent } from './ai';
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

function matchPositions(positions: FoundPosition[], match: { color?: string; size?: string; kind?: string }): FoundPosition[] {
  return positions.filter(p =>
    (!match.color || p.color === match.color) &&
    (!match.size || p.size === match.size) &&
    (!match.kind || p.kind === match.kind),
  );
}

export async function handleAIMessage(ctx: Context, env: Env, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const schema = await getSchema(env.notion, env.kv);
  let intent: AIIntent;
  try {
    intent = await parseIntent(env.anthropicKey, text, schema);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка AI: ${err?.message ?? err}`);
    return;
  }

  if (intent.intent === 'unclear') {
    await ctx.reply(`🤔 Не понял: ${intent.reason}\n\nКоманды: /new /status /orders /refresh`);
    return;
  }

  // Read-only: показ заказов (без подтверждения)
  if (intent.intent === 'show_orders') {
    return handleShowOrders(ctx, env, intent);
  }

  // Все остальные intents требуют телефон
  if (!intent.phone) {
    await ctx.reply('❌ Не указан телефон клиента в запросе.');
    return;
  }

  // Read-only: показать клиента / чек
  if (intent.intent === 'show_client') {
    const clients = await findClientsByPhone(env.notion, intent.phone);
    if (clients.length === 0) { await ctx.reply(`❌ Клиент с номером ${intent.phone} не найден.`); return; }
    if (clients.length > 1) { await ctx.reply(`❌ Несколько клиентов (${clients.length}). Уточни номер.`); return; }
    const c = clients[0];
    if (intent.mode === 'receipt') {
      await ctx.reply(formatReceipt(c));
    } else {
      await ctx.reply(formatFullCard(c));
    }
    return;
  }

  const clients = await findClientsByPhone(env.notion, intent.phone);
  if (clients.length === 0) {
    await ctx.reply(`❌ Клиент с номером ${intent.phone} не найден.`);
    return;
  }
  if (clients.length > 1) {
    await ctx.reply(`❌ Найдено несколько клиентов (${clients.length}) с похожим номером. Уточни.`);
    return;
  }

  const client = clients[0];
  await prepareEdit(ctx, env, client, intent);
}

async function prepareEdit(ctx: Context, env: Env, client: FoundClient, intent: AIIntent): Promise<void> {
  const userId = ctx.from!.id;

  switch (intent.intent) {
    case 'change_date': {
      const desc = `📅 Дата: ${fmtDate(client.date)} → ${fmtDate(intent.newDate)}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_client', changes: { date: intent.newDate } },
      ]);
    }
    case 'change_status': {
      const desc = `🚦 Статус: ${client.status ?? '—'} → ${intent.newStatus}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_client', changes: { status: intent.newStatus } },
      ]);
    }
    case 'change_payment': {
      const cur = client.paid ?? 0;
      const next = intent.setPaid !== undefined ? intent.setPaid : cur + (intent.addPaid ?? 0);
      const desc = `💰 Оплачено: ${cur} → ${next} тг`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_client', changes: { paid: next } },
      ]);
    }
    case 'change_note': {
      const desc = `💬 Примечание: ${client.note ?? '—'} → ${intent.note}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_client', changes: { note: intent.note } },
      ]);
    }
    case 'change_school': {
      const desc = `🏫 Уч. заведение: ${client.school ?? '—'} → ${intent.newSchool}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_client', changes: { school: intent.newSchool } },
      ]);
    }
    case 'add_position': {
      const desc = `➕ Добавить: ${intent.color} ${intent.size} ${intent.kind} ×${intent.qty}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'add_position', pos: { color: intent.color, size: intent.size, kind: intent.kind, qty: intent.qty } },
      ]);
    }
    case 'split_position': {
      const sources = matchPositions(client.positions, intent.positionMatch);
      if (sources.length === 0) {
        await ctx.reply(`❌ Не нашёл позицию для деления: ${formatPos(intent.positionMatch)}`);
        return;
      }
      if (sources.length > 1) {
        await ctx.reply(`❌ Несколько подходящих позиций (${sources.length}). Уточни цвет/размер/вид.`);
        return;
      }
      const src = sources[0];
      if ((src.qty ?? 0) < intent.qty) {
        await ctx.reply(`❌ В позиции «${formatPos(src)}» только ${src.qty} шт. Нельзя забрать ${intent.qty}.`);
        return;
      }
      const target = {
        color: intent.newColor ?? src.color,
        size: intent.newSize ?? src.size,
        kind: intent.newKind ?? src.kind,
      };
      // ищем существующую позицию того же клиента которая совпадает с target по всем 3 полям
      const dest = client.positions.find(p =>
        p.pageId !== src.pageId &&
        p.color === target.color &&
        p.size === target.size &&
        p.kind === target.kind,
      );
      const remaining = (src.qty ?? 0) - intent.qty;
      const ops: PendingOp[] = [];
      if (remaining === 0) {
        ops.push({ type: 'archive_position', positionPageId: src.pageId });
      } else {
        ops.push({ type: 'update_position', positionPageId: src.pageId, changes: { qty: remaining } });
      }
      if (dest) {
        ops.push({ type: 'update_position', positionPageId: dest.pageId, changes: { qty: (dest.qty ?? 0) + intent.qty } });
      } else {
        if (!target.color || !target.size || !target.kind) {
          await ctx.reply('❌ Недостаточно данных для целевой позиции.');
          return;
        }
        ops.push({ type: 'add_position', pos: { color: target.color, size: target.size, kind: target.kind, qty: intent.qty } });
      }
      const srcAfter = remaining === 0 ? '(удалить)' : `${formatPos(src)} → ×${remaining}`;
      const destAfter = dest
        ? `${formatPos(dest)} → ×${(dest.qty ?? 0) + intent.qty}`
        : `создать ${target.color} ${target.size} ${target.kind} ×${intent.qty}`;
      const desc = `✏ Разделить ${intent.qty} шт:\n  • было: ${formatPos(src)}\n  • станет: ${srcAfter}\n  • перенос: ${destAfter}`;
      return saveAndPrompt(ctx, env, client, desc, ops);
    }

    case 'change_position': {
      const matches = matchPositions(client.positions, intent.positionMatch);
      if (matches.length === 0) {
        await ctx.reply(`❌ Не нашёл позицию для изменения: ${formatPos(intent.positionMatch)}`);
        return;
      }
      if (matches.length > 1) {
        // несколько подходят — список выбора
        const session = emptySession();
        session.step = 'edit_pick_position';
        session.positionCandidates = matches.map(m => ({
          positionPageId: m.pageId,
          label: formatPos(m),
        }));
        session.pendingChange = {
          type: 'change_position',
          phone: client.phone,
          match: intent.positionMatch,
          newColor: intent.newColor,
          newSize: intent.newSize,
          newKind: intent.newKind,
          newQty: intent.newQty,
        };
        session.selectedPageId = client.pageId;
        await saveSession(env.kv, userId, session);
        const kb = new InlineKeyboard();
        for (const m of matches) {
          kb.text(`✏ ${formatPos(m)}`, `pickpos:${m.pageId}`).row();
        }
        kb.text('❌ Отмена', 'pickpos:cancel');
        await ctx.reply(
          `Найдено несколько подходящих позиций. Выбери какую менять:\n\n${formatClient(client)}`,
          { reply_markup: kb },
        );
        return;
      }
      const pos = matches[0];
      const desc = buildChangePosDesc(pos, intent);
      const changes = buildChangePosChanges(intent);
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'update_position', positionPageId: pos.pageId, changes },
      ]);
    }
  }
}

function buildChangePosDesc(pos: FoundPosition, intent: Extract<AIIntent, { intent: 'change_position' }>): string {
  const before = formatPos(pos);
  const after = formatPos({
    color: intent.newColor ?? pos.color,
    size: intent.newSize ?? pos.size,
    kind: intent.newKind ?? pos.kind,
    qty: intent.newQty ?? pos.qty,
  });
  return `✏ Позиция: ${before} → ${after}`;
}

function buildChangePosChanges(intent: Extract<AIIntent, { intent: 'change_position' }>): Record<string, any> {
  const c: Record<string, any> = {};
  if (intent.newColor) c.color = intent.newColor;
  if (intent.newSize) c.size = intent.newSize;
  if (intent.newKind) c.kind = intent.newKind;
  if (intent.newQty !== undefined) c.qty = intent.newQty;
  return c;
}

async function saveAndPrompt(
  ctx: Context,
  env: Env,
  client: FoundClient,
  description: string,
  operations: PendingOp[],
): Promise<void> {
  const userId = ctx.from!.id;
  const session = emptySession();
  session.step = 'edit_confirm';
  session.pendingEdit = {
    clientPageId: client.pageId,
    description,
    operations,
  };
  await saveSession(env.kv, userId, session);
  const kb = new InlineKeyboard()
    .text('✅ Применить', 'edit:apply')
    .text('❌ Отмена', 'edit:cancel');
  await ctx.reply(
    `Текущий клиент:\n${formatClient(client)}\n\nИзменения:\n${description}`,
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
    await ctx.reply(`✅ Применено: ${pe.description}`);
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
  if (!pc || pc.type !== 'change_position' || !session.selectedPageId) {
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
  const pos = client.positions.find(p => p.pageId === positionPageId);
  if (!pos) {
    await ctx.reply('Позиция не найдена.');
    await clearSession(env.kv, userId);
    return;
  }
  const intent: Extract<AIIntent, { intent: 'change_position' }> = {
    intent: 'change_position',
    phone: pc.phone,
    positionMatch: pc.match,
    newColor: pc.newColor,
    newSize: pc.newSize,
    newKind: pc.newKind,
    newQty: pc.newQty,
  };
  const desc = buildChangePosDesc(pos, intent);
  const changes = buildChangePosChanges(intent);
  return saveAndPrompt(ctx, env, client, desc, [
    { type: 'update_position', positionPageId: pos.pageId, changes },
  ]);
}
