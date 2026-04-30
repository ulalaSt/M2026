import { Schema } from './schema';

export type AIIntent =
  | { intent: 'change_date'; phone: string; newDate: string }
  | { intent: 'change_status'; phone: string; newStatus: string }
  | { intent: 'change_payment'; phone: string; addPaid?: number; setPaid?: number }
  | { intent: 'change_note'; phone: string; note: string }
  | { intent: 'change_school'; phone: string; newSchool: string }
  | {
      intent: 'update_positions';
      phone: string;
      // match отсутствует или пустой → применить ко ВСЕМ позициям клиента
      match?: { color?: string; size?: string; kind?: string };
      // что изменить
      newColor?: string;
      newSize?: string;
      newKind?: string;
      newQty?: number;
      // если указан splitQty — отщепить N штук с найденной позиции (split)
      splitQty?: number;
    }
  | { intent: 'add_position'; phone: string; color: string; size: string; kind: string; qty: number }
  | { intent: 'show_client'; phone: string; mode?: 'card' | 'receipt' }
  | { intent: 'show_orders'; startDate?: string; endDate?: string; limit?: number; status?: string }
  | { intent: 'show_timeline'; startDate: string; endDate: string }
  | { intent: 'unclear'; reason: string };

const TOOL = {
  name: 'register_intent',
  description: 'Зарегистрировать намерение пользователя по редактированию клиента',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['change_date', 'change_status', 'change_payment', 'change_note', 'change_school', 'update_positions', 'add_position', 'show_client', 'show_orders', 'show_timeline', 'unclear'],
        description: 'Тип действия',
      },
      phone: { type: 'string', description: 'Телефон клиента или пустая строка если не указан' },
      newDate: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
      newStatus: { type: 'string', description: 'Новый статус (точно из списка)' },
      addPaid: { type: 'number', description: 'Сколько добавить к оплате' },
      setPaid: { type: 'number', description: 'Установить оплачено в это значение' },
      note: { type: 'string', description: 'Текст примечания' },
      match: {
        type: 'object',
        description: 'Фильтр позиций для update_positions. Пусто/отсутствует = все позиции клиента.',
        properties: {
          color: { type: 'string' },
          size: { type: 'string' },
          kind: { type: 'string' },
        },
      },
      splitQty: { type: 'number', description: 'Сколько штук отщепить (split). Если указан — берётся одна позиция по match и из неё переносится N штук в новую с set.' },
      newColor: { type: 'string' },
      newSize: { type: 'string' },
      newKind: { type: 'string' },
      newQty: { type: 'number' },
      newSchool: { type: 'string', description: 'Точное название учебного заведения из списка' },
      color: { type: 'string' },
      size: { type: 'string' },
      kind: { type: 'string' },
      qty: { type: 'number' },
      reason: { type: 'string', description: 'Объяснение если intent=unclear' },
      mode: { type: 'string', enum: ['card', 'receipt'], description: 'card = карточка клиента; receipt = чек/расчёт по оплате' },
      startDate: { type: 'string', description: 'Дата начала диапазона YYYY-MM-DD' },
      endDate: { type: 'string', description: 'Дата конца диапазона YYYY-MM-DD' },
      limit: { type: 'number', description: 'Сколько ближайших заказов показать (если диапазон не задан)' },
      status: { type: 'string', description: 'Фильтр по статусу для show_orders' },
    },
    required: ['intent'],
  },
};

function buildSystemPrompt(schema: Schema): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Ты помощник для редактирования клиентов в базе мантий. Извлекай намерение из сообщения и вызывай инструмент register_intent.

Сегодня: ${today}.

Доступные значения:
- statuses: ${schema.statuses.join(', ')}
- schools: ${schema.schools.join(', ')}
- colors: ${schema.colors.join(', ')}
- sizes: ${schema.sizes.join(', ')}
- kinds: ${schema.kinds.join(', ')}

Понимаешь русский И казахский. Маппинг казахских слов → значения базы (которые на русском):

Статусы:
- "забрал/получил/выдан/выполнен" / каз. "алып кетті/алды/берді/берілді/орындалды" → ЗАБРАЛИ
- "вернул/возврат" / каз. "қайтарды/қайтарылды" → ВЕРНУЛИ
- "бронь" / каз. "брон" → БРОНЬ

Оплата:
- "оплатил ещё N / доплатил N" / каз. "тағы N төледі / қосымша N" → addPaid=N (НЕ setPaid)
- "оплатил всего N / оплачено N" / каз. "барлығы N төленді" → setPaid=N

Цвета на казахском (примерно): жасыл=зелёный, қызыл=красный, көк=синий, бордо=бордовый, ақ=белый, қара=чёрный — выбирай ближайший из списка colors выше.

Размеры: на казахском как и на русском (S/M/L).

Виды:
- "ересек/үлкен" → Взрослый
- "балалар" → Детский
- "бала бақша/бақша" → Садик

Правила действий:
- "добавь N" / каз. "қос/қосу N" → add_position с qty=N
- update_positions — универсальное обновление позиций:
  - "все позиции на M" / "сделай всех Взрослыми" → match отсутствует, newSize='M' (или newKind='Взрослый')
  - "поменяй M на L" → match={size:'M'}, newSize='L'
  - "поменяй зелёный на красный" → match={color:'🟢 зелёный'}, newColor='🔴 красный'
  - "поменяй кол-во M на 10" → match={size:'M'}, newQty=10
  - "перенеси N M на S" / "разбей N зелёный на красный" → match={size:'M'}, newSize='S', splitQty=N
  - newQty в обычном режиме (без splitQty) ставит количество для всех найденных
  - splitQty — отщепляет N штук из ОДНОЙ найденной позиции и переносит в новую с указанными изменениями
- "перенеси на <дата>" / "поменяй дату" / каз. "<дата>-ға ауыстыр / көшір" → change_date (формат YYYY-MM-DD)
- "школа <X>" / "это тоже <X>" / "уч.заведение <X>" / каз. "мектеп <X>" → change_school. newSchool — выбирай ближайшее из schools (можно по части названия).

Read-only запросы:
- "покажи 1234" / "карточка 1234" / каз. "1234-ті көрсет" → show_client с phone, mode=card
- "сколько осталось платить у 1234" / "какие мантии у 1234" → show_client с phone, mode=card (карточка показывает остаток и позиции)
- "чек клиенту 1234" / "квитанция 1234" / каз. "чек 1234" → show_client с phone, mode=receipt (форматированный текст для пересылки клиенту)
- "покажи на завтра / сегодня / N дней" / "что подготовить на завтра" / "заказы на эту неделю" → show_orders с startDate/endDate (даты вычисляешь от сегодня)
- "ближайший заказ" / "следующий заказ" → show_orders с startDate=сегодня, limit=1
- "первые N заказов" / "ближайшие N заказов" / "следующие N" → show_orders с startDate=сегодня, limit=N
- "таймлайн" / "календарь на месяц" / "по дням" / "визуально по датам" → show_timeline. startDate/endDate обязательны (если месяц — 30 дней от сегодня).
- Запросы read-only НЕ требуют подтверждения — выполняются сразу.
- ВАЖНО: клиенты идентифицируются ТОЛЬКО по телефону. Любые цифры от 4 до 11 длиной упомянутые в команде — это телефон или его последние цифры. Никаких "номеров заказа" / "ID клиента" / "номеров заявки" не существует — это всё телефон.
- "по 5566", "на заказе 5566", "у клиента 5566", "5566 ...", "клиент 1234" → phone="5566" (или "1234" — передавай цифры как есть, поиск найдёт по последним цифрам)
- Телефон может быть полным (87771112233, +77771112233) или последними 4-7 цифрами ("2233", "112233"). Передавай как есть в phone.
- Если в команде вообще нет цифр-идентификатора — phone=""
- Используй ТОЛЬКО значения из списков выше. Никогда не придумывай новых статусов/цветов/размеров/видов.
- Если непонятно или не хватает данных — intent=unclear с reason.`;
}

export type ModelKey = 'haiku' | 'sonnet';
export type Usage = { inputTokens: number; outputTokens: number; model: ModelKey };
export type AIResult = { intent: AIIntent; usage: Usage };

const PRICING: Record<ModelKey, { in: number; out: number }> = {
  haiku: { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  sonnet: { in: 3 / 1_000_000, out: 15 / 1_000_000 },
};
const USD_KZT_RATE = 500;

export function formatUsage(u: Usage): string {
  const p = PRICING[u.model];
  const usd = u.inputTokens * p.in + u.outputTokens * p.out;
  const kzt = usd * USD_KZT_RATE;
  return `💸 Запрос: ${u.inputTokens} in + ${u.outputTokens} out = $${usd.toFixed(4)} (~${kzt.toFixed(2)} ₸)`;
}

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

/** Извлекает «телефонную» строку из произвольного текста. Любая последовательность 4+ цифр. */
export function extractPhoneFromText(text: string): string | null {
  const m = text.match(/(\+?\d[\d\s\-()]{3,}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits.length >= 4 ? digits : null;
}

export type ParseResult =
  | { kind: 'intent'; intent: AIIntent; usage: Usage }
  | { kind: 'question'; text: string; usage: Usage };

export async function parseIntent(
  apiKey: string,
  userMessage: string,
  schema: Schema,
  history: ChatMsg[] = [],
  clientContext?: string,
): Promise<ParseResult> {
  const messages = [...history, { role: 'user', content: userMessage }];
  let system = buildSystemPrompt(schema) + '\n\nЕсли в запросе не хватает данных или есть неоднозначность — задай уточняющий вопрос текстом (одно предложение, по делу). Если данных достаточно — сразу вызови register_intent. Не вызывай register_intent с intent=unclear — лучше задай вопрос.';
  if (clientContext) {
    system += '\n\n=== АКТУАЛЬНЫЕ ДАННЫЕ КЛИЕНТА (используй их вместо вопросов про позиции) ===\n' + clientContext;
  }
  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    temperature: 0,
    system,
    tools: [TOOL],
    messages,
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  const usage: Usage = {
    inputTokens: json?.usage?.input_tokens ?? 0,
    outputTokens: json?.usage?.output_tokens ?? 0,
    model: 'haiku',
  };
  const blocks = json?.content ?? [];
  const tool = blocks.find((c: any) => c.type === 'tool_use' && c.name === 'register_intent');
  if (tool) {
    return { kind: 'intent', intent: mapToIntent(tool.input ?? {}, schema), usage };
  }
  const text = blocks.find((c: any) => c.type === 'text');
  return { kind: 'question', text: (text?.text ?? 'Что-то не понял, уточни.').trim(), usage };
}


function mapToIntent(args: any, schema: Schema): AIIntent {
  const intent = args.intent as string;
  const phone = String(args.phone ?? '');
  const validate = (val: string | undefined, list: string[]): string | undefined => {
    if (!val) return undefined;
    if (list.includes(val)) return val;
    const lower = val.toLowerCase();
    return list.find(x => x.toLowerCase() === lower);
  };
  const validateFuzzy = (val: string | undefined, list: string[]): string | undefined => {
    if (!val) return undefined;
    const exact = validate(val, list);
    if (exact) return exact;
    const lower = val.toLowerCase();
    // ищем элемент списка содержащий val или наоборот
    return list.find(x => {
      const xl = x.toLowerCase();
      return xl.includes(lower) || lower.includes(xl);
    });
  };

  switch (intent) {
    case 'change_date': {
      if (!args.newDate) return { intent: 'unclear', reason: 'Не указана дата' };
      return { intent: 'change_date', phone, newDate: args.newDate };
    }
    case 'change_status': {
      const status = validate(args.newStatus, schema.statuses);
      if (!status) return { intent: 'unclear', reason: `Неизвестный статус: ${args.newStatus}` };
      return { intent: 'change_status', phone, newStatus: status };
    }
    case 'change_payment': {
      if (typeof args.addPaid === 'number') return { intent: 'change_payment', phone, addPaid: args.addPaid };
      if (typeof args.setPaid === 'number') return { intent: 'change_payment', phone, setPaid: args.setPaid };
      return { intent: 'unclear', reason: 'Не указана сумма оплаты' };
    }
    case 'change_note': {
      if (!args.note) return { intent: 'unclear', reason: 'Не указан текст примечания' };
      return { intent: 'change_note', phone, note: String(args.note) };
    }
    case 'change_school': {
      const school = validateFuzzy(args.newSchool, schema.schools);
      if (!school) return { intent: 'unclear', reason: `Неизвестное уч. заведение: ${args.newSchool}` };
      return { intent: 'change_school', phone, newSchool: school };
    }
    case 'update_positions': {
      const m = args.match ?? args.positionMatch ?? {};
      const match: { color?: string; size?: string; kind?: string } = {};
      if (m.color) match.color = validate(m.color, schema.colors) ?? undefined;
      if (m.size) match.size = validate(m.size, schema.sizes) ?? undefined;
      if (m.kind) match.kind = validate(m.kind, schema.kinds) ?? undefined;
      const hasMatch = !!(match.color || match.size || match.kind);
      const newColor = validate(args.newColor, schema.colors);
      const newSize = validate(args.newSize, schema.sizes);
      const newKind = validate(args.newKind, schema.kinds);
      const newQty = typeof args.newQty === 'number' ? args.newQty : undefined;
      const splitQty = typeof args.splitQty === 'number' ? args.splitQty : undefined;
      if (!newColor && !newSize && !newKind && newQty === undefined) {
        return { intent: 'unclear', reason: 'Не указано на что менять (цвет/размер/вид/кол-во)' };
      }
      if (splitQty !== undefined && !hasMatch) {
        return { intent: 'unclear', reason: 'Для split нужен match (откуда переносим)' };
      }
      return {
        intent: 'update_positions',
        phone,
        match: hasMatch ? match : undefined,
        newColor, newSize, newKind, newQty, splitQty,
      };
    }
    case 'add_position': {
      const color = validate(args.color, schema.colors);
      const size = validate(args.size, schema.sizes);
      const kind = validate(args.kind, schema.kinds);
      const qty = typeof args.qty === 'number' ? args.qty : undefined;
      if (!color || !size || !kind || !qty) {
        return { intent: 'unclear', reason: 'Не хватает данных для новой позиции (цвет/размер/вид/кол-во)' };
      }
      return { intent: 'add_position', phone, color, size, kind, qty };
    }
    case 'show_client': {
      if (!phone) return { intent: 'unclear', reason: 'Не указан телефон клиента' };
      const mode = args.mode === 'receipt' ? 'receipt' : 'card';
      return { intent: 'show_client', phone, mode };
    }
    case 'show_timeline': {
      if (!args.startDate || !args.endDate) {
        return { intent: 'unclear', reason: 'Не указан период для таймлайна' };
      }
      return { intent: 'show_timeline', startDate: args.startDate, endDate: args.endDate };
    }
    case 'show_orders': {
      const r: AIIntent = { intent: 'show_orders' };
      if (typeof args.startDate === 'string') r.startDate = args.startDate;
      if (typeof args.endDate === 'string') r.endDate = args.endDate;
      if (typeof args.limit === 'number') r.limit = args.limit;
      if (typeof args.status === 'string') r.status = args.status;
      if (!r.startDate && !r.endDate && !r.limit) {
        return { intent: 'unclear', reason: 'Не указан период или количество заказов' };
      }
      return r;
    }
    case 'unclear':
    default:
      return { intent: 'unclear', reason: String(args.reason ?? 'Не понял запрос') };
  }
}
