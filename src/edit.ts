import { Context, InlineKeyboard } from 'grammy';
import { Client as NotionClient } from '@notionhq/client';
import { getSchema } from './schema';
import { parseIntent, AIIntent } from './ai';
import {
  findClientsByPhone,
  updateClientPage,
  updatePositionPage,
  addPositionToClient,
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
  geminiKey: string;
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
    intent = await parseIntent(env.geminiKey, text, schema);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка AI: ${err?.message ?? err}`);
    return;
  }

  if (intent.intent === 'unclear') {
    await ctx.reply(`🤔 Не понял: ${intent.reason}\n\nКоманды: /new /status /orders /refresh`);
    return;
  }

  if (!intent.phone) {
    await ctx.reply('❌ Не указан телефон клиента в запросе.');
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
    case 'add_position': {
      const desc = `➕ Добавить: ${intent.color} ${intent.size} ${intent.kind} ×${intent.qty}`;
      return saveAndPrompt(ctx, env, client, desc, [
        { type: 'add_position', pos: { color: intent.color, size: intent.size, kind: intent.kind, qty: intent.qty } },
      ]);
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
