import { Context, InlineKeyboard, Keyboard } from 'grammy';
import { Client as NotionClient } from '@notionhq/client';
import { Session, getSession, saveSession, clearSession, emptySession, DraftPosition, DraftClient } from './session';
import { getSchema, Schema } from './schema';
import { createClientWithPositions, searchClients, searchClientsByDateRange, updateClientStatus, archiveClient, loadClientPositions, updateClientFull, getClient, ClientSummary } from './notion';
import { handleAIMessage, applyPendingEdit, cancelPendingEdit, pickPosition, handleParsedIntent } from './edit';
import { parseIntent, formatUsage } from './ai';
import { transcribeAudio, LOW_CONFIDENCE_THRESHOLD } from './voice';

type Env = {
  kv: KVNamespace;
  notion: NotionClient;
  anthropicKey: string;
  groqKey: string;
  telegramToken: string;
};

// --- Утилиты для клавиатур ---

function selectKeyboard(options: string[], prefix: string, perRow = 2, extras: Array<{ label: string; data: string }> = []): InlineKeyboard {
  const kb = new InlineKeyboard();
  options.forEach((opt, i) => {
    kb.text(opt, `${prefix}:${i}`);
    if ((i + 1) % perRow === 0) kb.row();
  });
  if (options.length % perRow !== 0) kb.row();
  for (const e of extras) kb.text(e.label, e.data).row();
  return kb;
}

function dateKeyboard(prefix: string): InlineKeyboard {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  return new InlineKeyboard()
    .text('Сегодня', `${prefix}:${toIso(today)}`)
    .text('Завтра', `${prefix}:${toIso(tomorrow)}`)
    .row()
    .text('Ввести дату', `${prefix}:manual`);
}

function moreKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('+ Ещё позиция', 'more:add')
    .text('✅ Готово', 'more:done')
    .row();
}

function extrasKeyboard(d: DraftClient, editing = false): InlineKeyboard {
  const v = (s: any) => (s !== undefined && s !== '' ? '✓' : '');
  const kb = new InlineKeyboard();
  if (d.phone) kb.url('💬 Открыть в WhatsApp', whatsappUrl(d.phone)).row();
  return kb
    .text(`Телефон ${v(d.phone)}`, 'ext:phone')
    .text(`Дата ${v(d.date)}`, 'ext:date')
    .row()
    .text(`Уч. заведение ${v(d.school)}`, 'ext:school')
    .text(`Время ${v(d.time)}`, 'ext:time')
    .row()
    .text(`Цена ${v(d.price)}`, 'ext:price')
    .text(`Оплачено ${v(d.paid)}`, 'ext:paid')
    .row()
    .text(`Скидка ${v(d.discount)}`, 'ext:discount')
    .text(`Примечание ${v(d.note)}`, 'ext:note')
    .row()
    .text(`Позиции (${d.positions.length})`, 'ext:positions')
    .row()
    .text(editing ? '✅ Сохранить' : '✅ Создать', 'confirm:yes')
    .text('❌ Отмена', 'confirm:no')
    .row();
}

function clearKeyboard(prefix: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗑 Очистить', `${prefix}:clear`)
    .text('⬅️ Назад', `${prefix}:back`);
}

function positionsListKeyboard(positions: DraftPosition[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  positions.forEach((p, i) => {
    kb.text(`🗑 ${formatPositionShort(p)}`, `pos_del:${i}`).row();
  });
  kb.text('➕ Добавить позицию', 'pos_del:add').row();
  kb.text('⬅️ Назад', 'pos_del:back');
  return kb;
}

// --- Команды ---

export async function handleStart(ctx: Context): Promise<void> {
  const kb = new Keyboard()
    .text('🆕 Новый клиент').text('🔍 Статус').row()
    .text('📅 Заказы').row()
    .text('🔄 Обновить опции').text('❌ Отмена').row()
    .text('ℹ️ Помощь')
    .resized()
    .persistent();
  await ctx.reply(
    'М2026 бот.\n\nГлавное меню — кнопки внизу.\n\n' +
    '🤖 Можно писать произвольным текстом, например:\n' +
    '• «по 7778825092 поменяй дату на 5 мая»\n' +
    '• «77788258092 статус забрал»\n' +
    '• «77788258092 оплатил ещё 5000»\n' +
    '• «77788258092 поменяй зелёный M на L»\n' +
    '• «77788258092 добавь 2 бордовых S Взрослый»',
    { reply_markup: kb },
  );
}

export async function handleNew(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const session = emptySession();
  session.step = 'phone';
  await saveSession(env.kv, userId, session);
  await ctx.reply('Номер телефона?');
}

export async function handleCancel(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  await clearSession(env.kv, userId);
  await ctx.reply('Отменено.');
}

export async function handleOrders(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  await clearSession(env.kv, userId);
  const kb = new InlineKeyboard()
    .text('Сегодня', 'orders:today')
    .text('Завтра', 'orders:tomorrow')
    .row()
    .text('След. 7 дней', 'orders:7days')
    .row()
    .text('Выбрать день', 'orders:day')
    .text('Промежуток', 'orders:range');
  await ctx.reply('📅 Заказы за период:', { reply_markup: kb });
}

export async function handleStatus(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const session = emptySession();
  session.step = 'status_query';
  await saveSession(env.kv, userId, session);
  await ctx.reply('Введите номер или последние 4 цифры:');
}

export async function handleRefresh(ctx: Context, env: Env): Promise<void> {
  await withLoading(ctx, '⏳ Обновляю кэш...', async () => {
    await getSchema(env.notion, env.kv, true);
  });
  await ctx.reply('Кэш опций обновлён из Notion.');
}

// --- Голосовое сообщение ---

export async function handleVoice(ctx: Context, env: Env): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;
  if ((voice.duration ?? 0) > 60) {
    await ctx.reply('Голосовое слишком длинное (макс 60 сек). Запиши покороче.');
    return;
  }
  await ctx.replyWithChatAction('typing').catch(() => {});
  const listening = await ctx.reply('🎤 Слушаю...').catch(() => null);
  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) throw new Error('Не получен путь файла от Telegram');
    const url = `https://api.telegram.org/file/bot${env.telegramToken}/${file.file_path}`;
    const audioResp = await fetch(url);
    if (!audioResp.ok) throw new Error(`Скачивание аудио: ${audioResp.status}`);
    const buf = await audioResp.arrayBuffer();
    const schema = await getSchema(env.notion, env.kv);

    // Шаг 1: Whisper → текст
    const { text, avgLogprob } = await transcribeAudio(env.groqKey, buf, schema);
    console.log(`[handleVoice] transcript="${text}" avgLogprob=${avgLogprob}`);
    if (listening) {
      await ctx.api.deleteMessage(listening.chat.id, listening.message_id).catch(() => {});
    }
    if (!text) {
      await ctx.reply('❌ Не удалось распознать речь. Попробуй ещё раз.');
      return;
    }
    const lowConfidence = typeof avgLogprob === 'number' && avgLogprob < LOW_CONFIDENCE_THRESHOLD;
    const recognizedMsg = lowConfidence
      ? `🎤 Распознано: ${text}\n\n⚠️ Уверенность распознавания низкая, проверь команду перед подтверждением.`
      : `🎤 Распознано: ${text}`;
    await ctx.reply(recognizedMsg);

    // Шаг 2: текст → intent через Claude
    const { intent, usage } = await parseIntent(env.anthropicKey, text, schema);
    return handleParsedIntent(ctx, env, intent, formatUsage(usage));
  } catch (err: any) {
    if (listening) {
      await ctx.api.deleteMessage(listening.chat.id, listening.message_id).catch(() => {});
    }
    await ctx.reply(`❌ Ошибка распознавания: ${err?.message ?? err}`);
  }
}

// --- Контакт ---

export async function handleContact(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const phone = ctx.message?.contact?.phone_number;
  if (!phone) return;
  const session = await getSession(env.kv, userId);
  if (session.step !== 'phone' && session.step !== 'edit_phone') {
    await ctx.reply('Не понял. Команды: /new /cancel /refresh');
    return;
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    await ctx.reply('Неправильный номер.');
    return;
  }
  session.draft.phone = normalized;
  if (session.step === 'edit_phone') return askExtras(ctx, env, session);
  await askDate(ctx, env, session);
}

// --- Текстовые сообщения ---

export async function handleText(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const text = ctx.message?.text?.trim();
  if (!text) return;
  const session = await getSession(env.kv, userId);
  console.log(`[handleText] userId=${userId} step=${session.step} text=${text}`);

  switch (session.step) {
    case 'phone':
    case 'edit_phone': {
      const normalized = normalizePhone(text);
      if (!normalized) {
        await ctx.reply('Неправильный номер. Принимаю: 87788258091, +77788258091, +7 778 825 8091, 8 778 825 8091. Введите ещё раз:');
        return;
      }
      session.draft.phone = normalized;
      if (session.step === 'edit_phone') return askExtras(ctx, env, session);
      return askDate(ctx, env, session);
    }

    case 'date_manual':
    case 'edit_date_manual': {
      const iso = parseDate(text);
      if (!iso) {
        await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ или ДД.ММ:');
        return;
      }
      session.draft.date = iso;
      if (session.step === 'edit_date_manual') return askExtras(ctx, env, session);
      return askPosKind(ctx, env, session, true);
    }

    case 'pos_qty':
    case 'edit_pos_qty': {
      const num = parseInt(text.replace(/\s/g, ''), 10);
      if (isNaN(num) || num <= 0) {
        await ctx.reply('Введите целое число больше 0:');
        return;
      }
      session.currentPosition!.qty = num;
      session.draft.positions.push(session.currentPosition!);
      session.currentPosition = undefined;
      const last = session.draft.positions[session.draft.positions.length - 1];
      await ctx.reply(`✅ Добавлено: ${formatPositionShort(last)}`);
      if (session.step === 'edit_pos_qty') return askPositionsList(ctx, env, session);
      session.step = 'pos_more';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Ещё позиция или готово?', { reply_markup: moreKeyboard() });
      return;
    }

    case 'ext_time':
    case 'edit_time': {
      const m = text.match(/^(\d{1,2})[:.](\d{2})$/);
      if (!m) {
        await ctx.reply('Введите время в формате ЧЧ:ММ (например, 14:30):');
        return;
      }
      session.draft.time = `${m[1].padStart(2, '0')}:${m[2]}`;
      return session.step === 'edit_time' ? askExtras(ctx, env, session) : askExtras(ctx, env, session);
    }

    case 'ext_price':
    case 'edit_price': {
      const num = parseNumber(text);
      if (num === null || num < 0) {
        await ctx.reply('Введите число (например, 8000):');
        return;
      }
      session.draft.price = num;
      return session.step === 'edit_price' ? askExtras(ctx, env, session) : askExtras(ctx, env, session);
    }

    case 'ext_paid':
    case 'edit_paid': {
      const num = parseNumber(text);
      if (num === null || num < 0) {
        await ctx.reply('Введите число:');
        return;
      }
      session.draft.paid = num;
      return session.step === 'edit_paid' ? askExtras(ctx, env, session) : askExtras(ctx, env, session);
    }

    case 'ext_discount':
    case 'edit_discount': {
      const num = parseNumber(text);
      if (num === null || num < 0) {
        await ctx.reply('Введите число:');
        return;
      }
      session.draft.discount = num;
      return session.step === 'edit_discount' ? askExtras(ctx, env, session) : askExtras(ctx, env, session);
    }

    case 'ext_note':
    case 'edit_note': {
      session.draft.note = text;
      return session.step === 'edit_note' ? askExtras(ctx, env, session) : askExtras(ctx, env, session);
    }

    case 'orders_day_input': {
      const iso = parseDate(text);
      if (!iso) {
        await ctx.reply('Введите дату ДД.ММ.ГГГГ или ДД.ММ:');
        return;
      }
      await clearSession(env.kv, userId);
      return showOrdersRange(ctx, env, iso, iso);
    }

    case 'orders_range_start': {
      const iso = parseDate(text);
      if (!iso) {
        await ctx.reply('Начальная дата ДД.ММ.ГГГГ:');
        return;
      }
      session.rangeStart = iso;
      session.step = 'orders_range_end';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Конечная дата ДД.ММ.ГГГГ:');
      return;
    }

    case 'orders_range_end': {
      const iso = parseDate(text);
      if (!iso) {
        await ctx.reply('Конечная дата ДД.ММ.ГГГГ:');
        return;
      }
      const start = session.rangeStart!;
      await clearSession(env.kv, userId);
      return showOrdersRange(ctx, env, start, iso);
    }

    case 'status_query': {
      const results = await withLoading(ctx, '⏳ Ищу...', () => searchClients(env.notion, text));
      if (results.length === 0) {
        await ctx.reply('Не найдено.');
        await clearSession(env.kv, userId);
        return;
      }
      if (results.length === 1) {
        await env.kv.put(`pick:${userId}`, JSON.stringify(results), { expirationTtl: 600 });
        return showClientCard(ctx, env, session, results[0]);
      }
      const kb = new InlineKeyboard();
      results.forEach((r, i) => {
        const label = `${r.phone}${r.school ? ' · ' + r.school : ''}${r.date ? ' · ' + r.date : ''}`;
        kb.text(label.slice(0, 60), `pick:${r.pageId}`).row();
      });
      session.step = 'idle';
      await saveSession(env.kv, userId, session);
      // храним выдачу в KV отдельно: ключ pickN — pageId, чтобы не светить все pageId в сессии
      await env.kv.put(`pick:${userId}`, JSON.stringify(results), { expirationTtl: 600 });
      await ctx.reply(`Найдено ${results.length}. Выберите:`, { reply_markup: kb });
      return;
    }

    case 'status_delete_confirm': {
      const target = session.selectedPhone ?? '';
      const inputDigits = text.replace(/\D/g, '');
      const targetDigits = target.replace(/\D/g, '');
      if (inputDigits !== targetDigits) {
        await ctx.reply('Номер не совпадает. Введите ровно тот же номер или /cancel:');
        return;
      }
      try {
        await withLoading(ctx, '⏳ Удаляю...', () => archiveClient(env.notion, session.selectedPageId!));
        await ctx.reply(`🗑 Удалён клиент ${target}`);
      } catch (err: any) {
        await ctx.reply(`❌ Ошибка: ${err?.message ?? err}`);
      }
      await clearSession(env.kv, userId);
      return;
    }

    default: {
      const looksLikePhoneOnly = /^[+\d\s\-()]+$/.test(text);
      const normalized = looksLikePhoneOnly ? normalizePhone(text) : null;
      if (normalized) {
        const results = await withLoading(ctx, '⏳ Ищу...', () => searchClients(env.notion, normalized));
        if (results.length === 1) {
          await env.kv.put(`pick:${userId}`, JSON.stringify(results), { expirationTtl: 600 });
          return showClientCard(ctx, env, session, results[0]);
        }
        if (results.length > 1) {
          const kb = new InlineKeyboard();
          results.forEach((r) => {
            const label = `${r.phone}${r.school ? ' · ' + r.school : ''}${r.date ? ' · ' + r.date : ''}`;
            kb.text(label.slice(0, 60), `pick:${r.pageId}`).row();
          });
          await env.kv.put(`pick:${userId}`, JSON.stringify(results), { expirationTtl: 600 });
          await ctx.reply(`Найдено ${results.length}. Выберите:`, { reply_markup: kb });
          return;
        }
        // не найдено — начинаем создание с уже введённым номером
        const fresh = emptySession();
        fresh.draft.phone = normalized;
        await ctx.reply(`Клиент с номером ${normalized} не найден. Создаю нового.`);
        return askDate(ctx, env, fresh);
      }
      // не телефон — пробуем как AI-команду на естественном языке
      return withLoading(ctx, '🤖 Думаю...', () => handleAIMessage(ctx, env, text));
    }
  }
}

// --- Callback ---

export async function handleCallback(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const ackText =
    data === 'confirm:yes' ? '⏳ Создаю клиента...'
    : /^chstatus:\d+/.test(data) ? '⏳ Обновляю статус...'
    : data === 'card:edit' ? '⏳ Загружаю клиента...'
    : /^pick:/.test(data) ? '⏳ Загружаю...'
    : /^orders:(today|tomorrow|7days)/.test(data) ? '⏳ Загружаю заказы...'
    : undefined;
  await ctx.answerCallbackQuery(ackText ? { text: ackText } : undefined).catch(() => {});

  // Кастомный календарь: cal:nav:<year>:<month>, cal:pick:<YYYY-MM-DD>, cal:noop
  if (data.startsWith('cal:')) {
    const [, sub, ...args] = data.split(':');
    if (sub === 'noop') return;
    if (sub === 'nav') {
      const y = parseInt(args[0], 10);
      const m = parseInt(args[1], 10);
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: calendarKeyboard(y, m) });
      } catch {}
      return;
    }
    if (sub === 'pick') {
      const iso = args.join(':');
      const session = await getSession(env.kv, userId);
      await showChoice(ctx, `Дата: ${iso}`);
      return handleDatePicked(ctx, env, session, iso);
    }
    return;
  }

  const session = await getSession(env.kv, userId);
  const [type, ...rest] = data.split(':');
  const value = rest.join(':');
  const schema = await getSchema(env.notion, env.kv);
  const lookup = (list: string[]): string | undefined => {
    const i = parseInt(value, 10);
    return Number.isFinite(i) ? list[i] : undefined;
  };

  switch (type) {
    // --- Дата (создание) ---
    case 'date': {
      if (value === 'manual') {
        session.step = 'date_manual';
        await saveSession(env.kv, userId, session);
        await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ или ДД.ММ:');
        return;
      }
      session.draft.date = value;
      return askPosKind(ctx, env, session, true);
    }

    // --- Позиция (создание) ---
    case 'pos_kind': {
      const picked = lookup(schema.kinds);
      if (!picked) return;
      await showChoice(ctx, `Вид: ${picked}`);
      session.currentPosition = session.currentPosition ?? {};
      session.currentPosition.kind = picked;
      session.step = 'pos_color';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Цвет?', { reply_markup: selectKeyboard(schema.colors, 'pos_color', 3) });
      return;
    }
    case 'pos_color': {
      const picked = lookup(schema.colors);
      if (!picked) return;
      await showChoice(ctx, `Цвет: ${picked}`);
      session.currentPosition!.color = picked;
      session.step = 'pos_size';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Размер?', { reply_markup: selectKeyboard(schema.sizes, 'pos_size', 3) });
      return;
    }
    case 'pos_size': {
      const picked = lookup(schema.sizes);
      if (!picked) return;
      await showChoice(ctx, `Размер: ${picked}`);
      session.currentPosition!.size = picked;
      session.step = 'pos_qty';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Количество?');
      return;
    }
    case 'more': {
      if (value === 'add') {
        await showChoice(ctx, 'Ещё позиция');
        return askPosKind(ctx, env, session, false);
      }
      if (value === 'done') {
        await showChoice(ctx, 'Готово');
        return askExtras(ctx, env, session);
      }
      return;
    }

    // --- Меню extras ---
    case 'ext': {
      const labels: Record<string, string> = {
        phone: 'Телефон', date: 'Дата', school: 'Уч. заведение', time: 'Время',
        price: 'Цена', paid: 'Оплачено', discount: 'Скидка', note: 'Примечание',
        positions: 'Позиции',
      };
      if (labels[value]) await showChoice(ctx, labels[value]);
      return goToExtField(ctx, env, session, value, true);
    }

    case 'back': {
      return askExtras(ctx, env, session);
    }

    case 'edit': {
      if (value === 'apply') {
        await showChoice(ctx, '⏳ Применяю изменения...');
        return applyPendingEdit(ctx, env);
      }
      if (value === 'cancel') {
        await showChoice(ctx, 'Отменено');
        return cancelPendingEdit(ctx, env);
      }
      return;
    }

    case 'pickpos': {
      if (value === 'cancel') {
        await showChoice(ctx, 'Отменено');
        return cancelPendingEdit(ctx, env);
      }
      await showChoice(ctx, 'Позиция выбрана');
      return pickPosition(ctx, env, value);
    }

    case 'orders': {
      const today = isoToday();
      if (value === 'today') {
        await showChoice(ctx, 'Сегодня');
        return showOrdersRange(ctx, env, today, today);
      }
      if (value === 'tomorrow') {
        await showChoice(ctx, 'Завтра');
        const t = isoOffset(1);
        return showOrdersRange(ctx, env, t, t);
      }
      if (value === '7days') {
        await showChoice(ctx, 'Следующие 7 дней');
        return showOrdersRange(ctx, env, today, isoOffset(7));
      }
      if (value === 'day') {
        await showChoice(ctx, 'Выбрать день');
        session.step = 'orders_day_input';
        await saveSession(env.kv, userId, session);
        await openCalendar(ctx, env);
        return;
      }
      if (value === 'range') {
        await showChoice(ctx, 'Промежуток');
        session.step = 'orders_range_start';
        await saveSession(env.kv, userId, session);
        await ctx.reply('Начальная дата:');
        await openCalendar(ctx, env);
        return;
      }
      return;
    }

    case 'pick': {
      const stored = await env.kv.get<ClientSummary[]>(`pick:${userId}`, 'json');
      const found = stored?.find(c => c.pageId === value);
      if (!found) {
        await ctx.reply('Сессия истекла. /status снова.');
        return;
      }
      await showChoice(ctx, found.phone);
      return showClientCard(ctx, env, session, found);
    }

    case 'chstatus': {
      // value = index в schema.statuses либо 'cancel'
      if (value === 'cancel') {
        await showChoice(ctx, 'Отменено');
        await clearSession(env.kv, userId);
        return;
      }
      const status = lookup(schema.statuses);
      if (!status || !session.selectedPageId) return;
      await showChoice(ctx, `Статус: ${status}`);
      const pageId = session.selectedPageId;
      try {
        await withLoading(ctx, '⏳ Обновляю...', () => updateClientStatus(env.notion, pageId, status));
        await ctx.reply(`✅ Статус обновлён: ${status}`);
        const fresh = await getClient(env.notion, pageId);
        await clearSession(env.kv, userId);
        return showClientCard(ctx, env, emptySession(), fresh);
      } catch (err: any) {
        await ctx.reply(`❌ Ошибка: ${err?.message ?? err}`);
        await clearSession(env.kv, userId);
        return;
      }
    }

    case 'card': {
      if (value === 'change_status') {
        await showChoice(ctx, 'Изменить статус');
        await ctx.reply('Новый статус?', {
          reply_markup: selectKeyboard(schema.statuses, 'chstatus', 2,
            [{ label: '❌ Отмена', data: 'chstatus:cancel' }]),
        });
        return;
      }
      if (value === 'delete') {
        await showChoice(ctx, 'Удалить');
        session.step = 'status_delete_confirm';
        await saveSession(env.kv, userId, session);
        await ctx.reply(`Для удаления введите номер ${session.selectedPhone}:`);
        return;
      }
      if (value === 'edit') {
        await showChoice(ctx, 'Изменить');
        if (!session.selectedPageId) return;
        const positions = await withLoading(ctx, '⏳ Загружаю позиции...', () => loadClientPositions(env.notion, session.selectedPageId!));
        // ищем клиента по pageId — сделаем через searchClients не получится, нужен прямой fetch
        const stored = await env.kv.get<ClientSummary[]>(`pick:${userId}`, 'json');
        const found = stored?.find(c => c.pageId === session.selectedPageId);
        const phone = session.selectedPhone ?? found?.phone ?? '';
        const draft: DraftClient = {
          phone,
          school: found?.school,
          date: found?.date,
          time: found?.time,
          price: found?.price,
          paid: found?.paid,
          discount: found?.discount,
          note: found?.note,
          positions,
        };
        const next = emptySession();
        next.draft = draft;
        next.editingPageId = session.selectedPageId;
        return askExtras(ctx, env, next);
      }
      return;
    }

    // --- Школы ---
    case 'ext_school_choice':
    case 'edit_school_choice': {
      const editing = type === 'edit_school_choice';
      if (value === 'list') {
        await showChoice(ctx, 'Из списка');
        session.step = editing ? 'edit_school' : 'ext_school';
        await saveSession(env.kv, userId, session);
        await ctx.reply('Выберите:', {
          reply_markup: selectKeyboard(schema.schools, editing ? 'edit_school' : 'ext_school', 2,
            [{ label: '⬅️ Назад', data: `${editing ? 'edit_school' : 'ext_school'}:back` }]),
        });
        return;
      }
      if (value === 'back') {
        await showChoice(ctx, 'Назад');
        return askExtras(ctx, env, session);
      }
      return;
    }
    case 'ext_school':
    case 'edit_school': {
      if (value === 'back') {
        await showChoice(ctx, 'Назад');
        return askExtras(ctx, env, session);
      }
      const picked = lookup(schema.schools);
      if (!picked) return;
      await showChoice(ctx, `Школа: ${picked}`);
      session.draft.school = picked;
      return askExtras(ctx, env, session);
    }

    // --- Confirm ---
    case 'confirm': {
      if (value === 'yes') {
        const missing: string[] = [];
        if (!session.draft.phone) missing.push('Телефон');
        if (!session.draft.date) missing.push('Дата');
        if (session.draft.positions.length === 0) missing.push('Позиции');
        if (missing.length) {
          await ctx.reply(`❗ Обязательные поля не заполнены: ${missing.join(', ')}`);
          return;
        }
        if ((session as any).creating) return;
        (session as any).creating = true;
        await saveSession(env.kv, userId, session);
        await showChoice(ctx, '⏳ Создаю клиента...');
        try {
          const editing = !!session.editingPageId;
          let pageId: string;
          if (editing) {
            await updateClientFull(env.notion, session.editingPageId!, session.draft);
            pageId = session.editingPageId!;
          } else {
            const result = await createClientWithPositions(env.notion, session.draft);
            pageId = result.pageId;
          }
          await clearSession(env.kv, userId);
          await ctx.reply(`✅ ${editing ? 'Обновлено' : 'Клиент создан'}!`);
          // Показываем актуальную карточку из Notion
          const fresh = await getClient(env.notion, pageId);
          return showClientCard(ctx, env, emptySession(), fresh);
        } catch (err: any) {
          console.error('[create] ERROR', err?.message ?? err, err?.stack);
          (session as any).creating = false;
          await saveSession(env.kv, userId, session);
          await ctx.reply(`❌ Ошибка при создании в Notion:\n${err?.message ?? err}`);
        }
        return;
      }
      if (value === 'no') {
        await showChoice(ctx, 'Отменено');
        await clearSession(env.kv, userId);
        return;
      }
      return;
    }

    // --- Очистка / возврат при редактировании одного поля ---
    case 'edit_clear': {
      const field = value as keyof DraftClient;
      await showChoice(ctx, `Очищено: ${field}`);
      if (field === 'phone' || field === 'date') return askExtras(ctx, env, session);
      delete (session.draft as any)[field];
      return askExtras(ctx, env, session);
    }

    // --- Дата при редактировании ---
    case 'edit_date': {
      if (value === 'manual') {
        session.step = 'edit_date_manual';
        await saveSession(env.kv, userId, session);
        await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ или ДД.ММ:');
        return;
      }
      if (value === 'back') return askExtras(ctx, env, session);
      session.draft.date = value;
      return askExtras(ctx, env, session);
    }

    // --- Позиции при редактировании ---
    case 'pos_del': {
      if (value === 'back') {
        await showChoice(ctx, 'Назад');
        return askExtras(ctx, env, session);
      }
      if (value === 'add') {
        await showChoice(ctx, 'Добавить позицию');
        session.step = 'edit_pos_kind';
        session.currentPosition = {};
        await saveSession(env.kv, userId, session);
        await ctx.reply('Вид?', { reply_markup: selectKeyboard(schema.kinds, 'edit_pos_kind', 3) });
        return;
      }
      const i = parseInt(value, 10);
      if (Number.isFinite(i)) {
        const removed = session.draft.positions[i];
        session.draft.positions.splice(i, 1);
        if (removed) await showChoice(ctx, `🗑 Удалено: ${formatPositionShort(removed)}`);
        return askPositionsList(ctx, env, session);
      }
      return;
    }
    case 'edit_pos_kind': {
      const picked = lookup(schema.kinds);
      if (!picked) return;
      await showChoice(ctx, `Вид: ${picked}`);
      session.currentPosition!.kind = picked;
      session.step = 'edit_pos_color';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Цвет?', { reply_markup: selectKeyboard(schema.colors, 'edit_pos_color', 3) });
      return;
    }
    case 'edit_pos_color': {
      const picked = lookup(schema.colors);
      if (!picked) return;
      await showChoice(ctx, `Цвет: ${picked}`);
      session.currentPosition!.color = picked;
      session.step = 'edit_pos_size';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Размер?', { reply_markup: selectKeyboard(schema.sizes, 'edit_pos_size', 3) });
      return;
    }
    case 'edit_pos_size': {
      const picked = lookup(schema.sizes);
      if (!picked) return;
      await showChoice(ctx, `Размер: ${picked}`);
      session.currentPosition!.size = picked;
      session.step = 'edit_pos_qty';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Количество?');
      return;
    }

  }
}

// --- Переходы / экраны ---

async function askDate(ctx: Context, env: Env, session: Session): Promise<void> {
  session.step = 'date';
  await saveSession(env.kv, ctx.from!.id, session);
  await openCalendar(ctx, env);
}

const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const WEEKDAYS_RU = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function calendarKeyboard(year: number, month: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text('‹', `cal:nav:${month === 0 ? year - 1 : year}:${month === 0 ? 11 : month - 1}`);
  kb.text(`${MONTHS_RU[month]} ${year}`, 'cal:noop');
  kb.text('›', `cal:nav:${month === 11 ? year + 1 : year}:${month === 11 ? 0 : month + 1}`).row();
  for (const wd of WEEKDAYS_RU) kb.text(wd, 'cal:noop');
  kb.row();
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun..6=Sat
  const offset = (firstDay + 6) % 7; // Mon=0
  const lastDate = new Date(year, month + 1, 0).getDate();
  let day = 1 - offset;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      if (day < 1 || day > lastDate) {
        kb.text(' ', 'cal:noop');
      } else {
        const mm = String(month + 1).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        kb.text(String(day), `cal:pick:${year}-${mm}-${dd}`);
      }
      day++;
    }
    kb.row();
    if (day > lastDate) break;
  }
  return kb;
}

async function showChoice(ctx: Context, label: string): Promise<void> {
  try {
    await ctx.editMessageText(`✓ ${label}`, { reply_markup: undefined });
  } catch {}
}

async function withLoading<T>(ctx: Context, label: string, fn: () => Promise<T>): Promise<T> {
  const loading = await ctx.reply(label).catch(() => null);
  try {
    return await fn();
  } finally {
    if (loading) {
      await ctx.api.deleteMessage(loading.chat.id, loading.message_id).catch(() => {});
    }
  }
}

async function openCalendar(ctx: Context, env: Env): Promise<void> {
  const now = new Date();
  await ctx.reply('Выберите дату:', { reply_markup: calendarKeyboard(now.getFullYear(), now.getMonth()) });
}

async function handleDatePicked(ctx: Context, env: Env, session: Session, iso: string): Promise<void> {
  const userId = ctx.from!.id;
  switch (session.step) {
    case 'date': {
      session.draft.date = iso;
      return askPosKind(ctx, env, session, true);
    }
    case 'edit_date': {
      session.draft.date = iso;
      return askExtras(ctx, env, session);
    }
    case 'orders_day_input': {
      await clearSession(env.kv, userId);
      return showOrdersRange(ctx, env, iso, iso);
    }
    case 'orders_range_start': {
      session.rangeStart = iso;
      session.step = 'orders_range_end';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Конечная дата:');
      return openCalendar(ctx, env);
    }
    case 'orders_range_end': {
      const start = session.rangeStart!;
      await clearSession(env.kv, userId);
      return showOrdersRange(ctx, env, start, iso);
    }
    default:
      await ctx.reply(`Дата выбрана: ${iso}`);
  }
}

async function askPosKind(ctx: Context, env: Env, session: Session, first: boolean): Promise<void> {
  session.step = 'pos_kind';
  session.currentPosition = {};
  await saveSession(env.kv, ctx.from!.id, session);
  const schema = await getSchema(env.notion, env.kv);
  const title = first
    ? 'Добавить позицию. Вид?'
    : `Позиция №${session.draft.positions.length + 1}. Вид?`;
  await ctx.reply(title, { reply_markup: selectKeyboard(schema.kinds, 'pos_kind', 3) });
}

async function askExtras(ctx: Context, env: Env, session: Session): Promise<void> {
  applyDefaults(session.draft);
  session.step = 'extras';
  await saveSession(env.kv, ctx.from!.id, session);
  await ctx.reply(
    `Следующее действие:\n\n${formatSummary(session.draft)}`,
    { reply_markup: extrasKeyboard(session.draft, !!session.editingPageId) },
  );
}

function applyDefaults(d: DraftClient): void {
  if (d.price === undefined) d.price = defaultPrice(totalQty(d.positions));
  if (d.paid === undefined) d.paid = 2000;
}

function totalQty(positions: DraftPosition[]): number {
  return positions.reduce((s, p) => s + (p.qty ?? 0), 0);
}

function defaultPrice(total: number): number {
  if (total >= 15) return 2000;
  if (total >= 10) return 2300;
  if (total >= 5) return 2600;
  return 3000;
}

async function showClientCard(ctx: Context, env: Env, session: Session, c: ClientSummary): Promise<void> {
  const userId = ctx.from!.id;
  const positions = await withLoading(ctx, '⏳ Загружаю позиции...', () => loadClientPositions(env.notion, c.pageId));
  session.step = 'idle';
  session.selectedPageId = c.pageId;
  session.selectedPhone = c.phone;
  await saveSession(env.kv, userId, session);
  const lines: string[] = [];
  lines.push(`📞 ${c.phone}`);
  if (c.status) lines.push(`📌 ${c.status}`);
  if (c.date) {
    const d = daysUntil(c.date);
    const tail = d === null ? '' : d === 0 ? ' (сегодня)' : d > 0 ? ` (через ${d} дн)` : ` (${-d} дн назад)`;
    lines.push(`📅 ${c.date}${c.time ? ' ' + c.time : ''}${tail}`);
  }
  if (c.school) lines.push(`🏫 ${c.school}`);
  if (typeof c.price === 'number') lines.push(`💵 Цена: ${c.price} тг`);
  if (typeof c.paid === 'number') lines.push(`💰 Оплачено: ${c.paid} тг`);
  if (typeof c.discount === 'number') lines.push(`🏷 Скидка: ${c.discount} тг`);
  if (c.note) lines.push(`💬 ${c.note}`);
  if (positions.length) {
    lines.push(`📦 Позиции (${positions.length}):`);
    for (const p of positions) lines.push(`  • ${formatPositionShort(p)}`);
  }
  const totalQty = positions.reduce((s, p) => s + (p.qty ?? 0), 0);
  if (typeof c.price === 'number' && totalQty > 0) {
    const remaining = c.price * totalQty - (c.paid ?? 0) - (c.discount ?? 0);
    lines.push(`💸 Остаток: ${remaining} тг`);
  }
  const kb = new InlineKeyboard()
    .text('🔁 Изменить статус', 'card:change_status')
    .text('✏️ Изменить', 'card:edit')
    .row()
    .text('🗑 Удалить', 'card:delete')
    .row()
    .url('🔗 Notion', c.url);
  if (c.phone) kb.url('💬 WhatsApp', whatsappUrl(c.phone));
  await ctx.reply(lines.join('\n'), { reply_markup: kb });
}

async function askPositionsList(ctx: Context, env: Env, session: Session): Promise<void> {
  session.step = 'edit_positions';
  await saveSession(env.kv, ctx.from!.id, session);
  await ctx.reply(`Позиции (${session.draft.positions.length}):`, {
    reply_markup: positionsListKeyboard(session.draft.positions),
  });
}

async function goToExtField(ctx: Context, env: Env, session: Session, field: string, editing: boolean): Promise<void> {
  const userId = ctx.from!.id;
  const schema = await getSchema(env.notion, env.kv);
  const prefix = editing ? 'edit' : 'ext';

  switch (field) {
    case 'phone': {
      session.step = 'edit_phone';
      await saveSession(env.kv, userId, session);
      await ctx.reply('Введите номер телефона:');
      return;
    }
    case 'date': {
      session.step = 'edit_date';
      await saveSession(env.kv, userId, session);
      await openCalendar(ctx, env);
      return;
    }
    case 'school': {
      session.step = editing ? 'edit_school_choice' : 'ext_school_choice';
      await saveSession(env.kv, userId, session);
      const cbPrefix = editing ? 'edit_school_choice' : 'ext_school_choice';
      await ctx.reply('Учебное заведение?', {
        reply_markup: new InlineKeyboard()
          .text('📋 Выбрать из списка', `${cbPrefix}:list`)
          .text('⬅️ Назад', `${cbPrefix}:back`),
      });
      return;
    }
    case 'time':
    case 'price':
    case 'paid':
    case 'discount':
    case 'note': {
      const stepMap: Record<string, Session['step']> = {
        time: editing ? 'edit_time' : 'ext_time',
        price: editing ? 'edit_price' : 'ext_price',
        paid: editing ? 'edit_paid' : 'ext_paid',
        discount: editing ? 'edit_discount' : 'ext_discount',
        note: editing ? 'edit_note' : 'ext_note',
      };
      session.step = stepMap[field];
      await saveSession(env.kv, userId, session);
      const prompts: Record<string, string> = {
        time: 'Время выдачи (ЧЧ:ММ)?',
        price: 'Цена за единицу (тенге)?',
        paid: 'Оплачено (тенге)?',
        discount: 'Скидка (тенге)?',
        note: 'Примечание?',
      };
      const has = (session.draft as any)[field];
      const opts: any = {};
      if (editing && has !== undefined && has !== '') {
        opts.reply_markup = new InlineKeyboard()
          .text('🗑 Очистить', `edit_clear:${field}`)
          .text('⬅️ Назад', 'back:');
      }
      await ctx.reply(prompts[field], opts);
      return;
    }
    case 'positions': {
      return askPositionsList(ctx, env, session);
    }
  }
}

// --- Утилиты ---

function parseDate(text: string): string | null {
  const m = text.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yyyy = m[3] ?? new Date().getFullYear().toString();
  if (yyyy.length === 2) yyyy = '20' + yyyy;
  return `${yyyy}-${mm}-${dd}`;
}

function parseNumber(text: string): number | null {
  const n = parseFloat(text.replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function formatPositionShort(p: DraftPosition): string {
  return `${p.color ?? ''} ${p.size ?? ''} ${p.kind ?? ''} ×${p.qty ?? ''}`.trim();
}

function formatSummary(d: DraftClient): string {
  const lines: string[] = [];
  if (d.phone) lines.push(`📞 ${d.phone}`);
  if (d.date) {
    const days = daysUntil(d.date);
    const tail = days === null ? '' : days === 0 ? ' (сегодня)' : days > 0 ? ` (через ${days} дн)` : ` (${-days} дн назад)`;
    lines.push(`📅 ${d.date}${d.time ? ' ' + d.time : ''}${tail}`);
  }
  if (d.school) lines.push(`🏫 ${d.school}`);
  if (typeof d.price === 'number') lines.push(`💵 Цена: ${d.price} тг`);
  if (typeof d.paid === 'number') lines.push(`💰 Оплачено: ${d.paid} тг`);
  if (typeof d.discount === 'number') lines.push(`🏷 Скидка: ${d.discount} тг`);
  if (d.note) lines.push(`💬 ${d.note}`);
  if (d.positions?.length) {
    lines.push(`📦 Позиции (${d.positions.length}):`);
    for (const p of d.positions) lines.push(`  • ${formatPositionShort(p)}`);
  }
  const remaining = computeRemaining(d);
  if (remaining !== null) lines.push(`💸 Остаток: ${remaining} тг`);
  return lines.join('\n') || '(пусто)';
}

function computeRemaining(d: DraftClient): number | null {
  if (typeof d.price !== 'number') return null;
  const total = d.positions.reduce((s, p) => s + (p.qty ?? 0), 0);
  if (total === 0) return null;
  const sum = d.price * total;
  return sum - (d.paid ?? 0) - (d.discount ?? 0);
}

function daysUntil(iso: string): number | null {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function showOrdersRange(ctx: Context, env: Env, startISO: string, endISO: string): Promise<void> {
  const clients = await withLoading(ctx, '⏳ Загружаю заказы...', () => searchClientsByDateRange(env.notion, startISO, endISO));
  if (clients.length === 0) {
    await ctx.reply(`📅 ${startISO === endISO ? startISO : `${startISO} — ${endISO}`}\nЗаказов нет.`);
    return;
  }
  // загружаем позиции параллельно
  const positionsByClient = await Promise.all(
    clients.map(c => loadClientPositions(env.notion, c.pageId).then(ps => ({ c, ps }))),
  );
  // агрегаты по цвет+вид (размеры игнорируем)
  const totals = new Map<string, number>();
  let totalPaid = 0;
  let totalSum = 0;
  for (const { c, ps } of positionsByClient) {
    const qty = ps.reduce((s, p) => s + (p.qty ?? 0), 0);
    if (typeof c.price === 'number') totalSum += c.price * qty;
    if (typeof c.paid === 'number') totalPaid += c.paid;
    for (const p of ps) {
      if (!p.color || !p.kind || !p.qty) continue;
      const key = `${p.color} ${p.kind}`;
      totals.set(key, (totals.get(key) ?? 0) + p.qty);
    }
  }
  const header: string[] = [];
  header.push(`📅 ${startISO === endISO ? startISO : `${startISO} — ${endISO}`}`);
  header.push(`📦 Заказов: ${clients.length}`);
  if (totals.size) {
    header.push('🎨 Итого:');
    for (const [k, q] of totals) header.push(`   • ${k} ×${q}`);
  }
  header.push(`💰 Оплачено: ${totalPaid} тг`);
  header.push(`💵 Сумма заказов: ${totalSum} тг`);
  header.push('');
  for (const { c, ps } of positionsByClient) {
    const lines: string[] = [];
    const titleParts = [c.phone];
    if (c.school) titleParts.push(c.school);
    if (c.date) titleParts.push(`${c.date}${c.time ? ' ' + c.time : ''}`);
    if (c.status) titleParts.push(c.status);
    lines.push('— ' + titleParts.join(' · '));
    for (const p of ps) lines.push(`   • ${formatPositionShort(p)}`);
    header.push(lines.join('\n'));
  }
  // Telegram имеет лимит 4096 символов, на всякий случай режу
  const text = header.join('\n');
  await ctx.reply(text.slice(0, 4000));
}

function whatsappUrl(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}`;
}

function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}
