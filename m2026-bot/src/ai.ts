import { Schema } from './schema';

export type AIIntent =
  | {
      intent: 'update_client';
      phone: string;
      date?: string;
      time?: string;
      school?: string;
      status?: string;
      addPaid?: number;
      setPaid?: number;
      discount?: number;
      note?: string;
    }
  | {
      intent: 'update_position';
      phone: string;
      positionIndex: number; // 1-based, ссылается на список из контекста
      newColor?: string;
      newSize?: string;
      newKind?: string;
      newQty?: number;
    }
  | { intent: 'add_position'; phone: string; color: string; size: string; kind: string; qty: number }
  | { intent: 'delete_position'; phone: string; positionIndex: number }
  | { intent: 'show_client'; phone: string; mode?: 'card' | 'receipt' }
  | { intent: 'show_orders'; startDate?: string; endDate?: string; limit?: number; status?: string }
  | { intent: 'show_timeline'; startDate: string; endDate: string }
  | { intent: 'unclear'; reason: string };

const ACTION_PROPERTIES = {
  intent: {
    type: 'string',
    enum: ['update_client', 'update_position', 'add_position', 'delete_position', 'show_client', 'show_orders', 'show_timeline', 'unclear'],
  },
  phone: { type: 'string', description: 'Телефон клиента или последние цифры. Пусто если не указан.' },
  // update_client поля
  date: { type: 'string', description: 'YYYY-MM-DD' },
  time: { type: 'string', description: 'HH:MM' },
  school: { type: 'string', description: 'Точно из списка schools' },
  status: { type: 'string', description: 'Точно из списка statuses' },
  addPaid: { type: 'number', description: 'Прибавить к оплачено' },
  setPaid: { type: 'number', description: 'Установить оплачено в это значение' },
  discount: { type: 'number' },
  note: { type: 'string' },
  // update_position / delete_position
  positionIndex: { type: 'number', description: '1-based индекс из списка позиций клиента' },
  newColor: { type: 'string' },
  newSize: { type: 'string' },
  newKind: { type: 'string' },
  newQty: { type: 'number' },
  // add_position
  color: { type: 'string' },
  size: { type: 'string' },
  kind: { type: 'string' },
  qty: { type: 'number' },
  // show_*
  mode: { type: 'string', enum: ['card', 'receipt'] },
  startDate: { type: 'string' },
  endDate: { type: 'string' },
  limit: { type: 'number' },
  // unclear
  reason: { type: 'string' },
} as const;

const TOOL = {
  name: 'register_intent',
  description: 'Зарегистрировать одно или несколько действий. Любую сложную задачу разлагай на простые CRUD-действия и возвращай массивом — они применятся одной транзакцией.',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: ACTION_PROPERTIES,
          required: ['intent'],
        },
      },
    },
    required: ['actions'],
  },
};

function buildSystemPrompt(schema: Schema): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Ты помощник для редактирования заказов мантий. Извлекай из сообщения список простых CRUD-действий и вызывай register_intent с массивом actions.

Сегодня: ${today}.

Доступные значения (используй ТОЛЬКО их):
- statuses: ${schema.statuses.join(', ')}
- schools: ${schema.schools.join(', ')}
- colors: ${schema.colors.join(', ')}
- sizes: ${schema.sizes.join(', ')}
- kinds: ${schema.kinds.join(', ')}

Действия (atom-операции):
- update_client — изменить любые поля клиента: date, time, school, status, addPaid (прибавить к оплачено), setPaid (установить оплачено), discount, note. Можно несколько полей одновременно.
- update_position — изменить ОДНУ позицию по индексу: positionIndex + newColor/newSize/newKind/newQty.
- add_position — добавить новую позицию: color, size, kind, qty.
- delete_position — удалить позицию по индексу.
- show_client (mode='card'|'receipt'), show_orders (startDate/endDate/limit), show_timeline (startDate/endDate), unclear (reason).

Принцип: разлагай сложное на простое и возвращай массивом.
- "поменяй все M на L" с 3 позициями M → массив из 3 update_position с newSize='L'.
- "перенеси 5 M на S" → 2 действия: update_position у источника (newQty = старое-5) + add_position {size:'S', qty:5} с тем же color/kind.
- "5566 забрал и доплатил 2000" → 1 update_client {status:'ЗАБРАЛИ', addPaid:2000}.
- Если в команде есть несколько изменений — обязательно делай массив, а не задавай уточняющие вопросы.

Понимаешь русский и казахский. Маппинг (выбирай ближайшее из списков):
- "забрал/получил/выдан" / каз. "алып кетті/алды/берді" → ЗАБРАЛИ
- "вернул" / "қайтарды" → ВЕРНУЛИ
- "бронь" / "брон" → БРОНЬ
- цвета каз: жасыл=зелёный, қызыл=красный, көк=синий, бордо=бордовый, ақ=белый, қара=чёрный
- виды каз: ересек=Взрослый, балалар=Детский, бақша=Садик

Идентификация клиента:
- Любые цифры 4-11 длиной — это телефон или его последние цифры. Передавай как есть в phone.
- Никаких "номеров заказа" не существует — всё это телефон.
- Если в команде нет цифр — phone="".

Если данных не хватает или есть неоднозначность — задай короткий уточняющий вопрос текстом ВМЕСТО tool call. Если данных достаточно — сразу register_intent (даже если несколько действий).`;
}

export type ModelKey = 'haiku' | 'sonnet';
export type Usage = { inputTokens: number; outputTokens: number; model: ModelKey };

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

export type ParseResult =
  | { kind: 'actions'; actions: AIIntent[]; usage: Usage }
  | { kind: 'question'; text: string; usage: Usage };

/** Извлекает «телефонную» строку из произвольного текста. Любая последовательность 4+ цифр. */
export function extractPhoneFromText(text: string): string | null {
  const m = text.match(/(\+?\d[\d\s\-()]{3,}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  return digits.length >= 4 ? digits : null;
}

export async function parseIntent(
  apiKey: string,
  userMessage: string,
  schema: Schema,
  history: ChatMsg[] = [],
  clientContext?: string,
): Promise<ParseResult> {
  const messages = [...history, { role: 'user', content: userMessage }];
  let system = buildSystemPrompt(schema);
  if (clientContext) {
    system += '\n\n=== АКТУАЛЬНЫЕ ДАННЫЕ КЛИЕНТА (используй индексы позиций отсюда) ===\n' + clientContext;
  }
  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: 800,
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
    const args = tool.input ?? {};
    const rawActions = Array.isArray(args.actions) ? args.actions : [args];
    const actions = rawActions.map((a: any) => mapToIntent(a, schema));
    return { kind: 'actions', actions, usage };
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
    return list.find(x => {
      const xl = x.toLowerCase();
      return xl.includes(lower) || lower.includes(xl);
    });
  };

  switch (intent) {
    case 'update_client': {
      const r: any = { intent: 'update_client', phone };
      if (typeof args.date === 'string') r.date = args.date;
      if (typeof args.time === 'string') r.time = args.time;
      const status = validate(args.status, schema.statuses);
      if (status) r.status = status;
      const school = validateFuzzy(args.school, schema.schools);
      if (school) r.school = school;
      if (typeof args.addPaid === 'number') r.addPaid = args.addPaid;
      if (typeof args.setPaid === 'number') r.setPaid = args.setPaid;
      if (typeof args.discount === 'number') r.discount = args.discount;
      if (typeof args.note === 'string') r.note = args.note;
      const hasAny = ['date','time','status','school','addPaid','setPaid','discount','note'].some(k => k in r);
      if (!hasAny) return { intent: 'unclear', reason: 'update_client без полей' };
      return r;
    }
    case 'update_position': {
      const idx = typeof args.positionIndex === 'number' ? args.positionIndex : NaN;
      if (!Number.isFinite(idx) || idx < 1) return { intent: 'unclear', reason: 'Не указан positionIndex' };
      const newColor = validate(args.newColor, schema.colors);
      const newSize = validate(args.newSize, schema.sizes);
      const newKind = validate(args.newKind, schema.kinds);
      const newQty = typeof args.newQty === 'number' ? args.newQty : undefined;
      if (!newColor && !newSize && !newKind && newQty === undefined) {
        return { intent: 'unclear', reason: 'Не указано что менять у позиции' };
      }
      return { intent: 'update_position', phone, positionIndex: idx, newColor, newSize, newKind, newQty };
    }
    case 'add_position': {
      const color = validate(args.color, schema.colors);
      const size = validate(args.size, schema.sizes);
      const kind = validate(args.kind, schema.kinds);
      const qty = typeof args.qty === 'number' ? args.qty : undefined;
      if (!color || !size || !kind || !qty) {
        return { intent: 'unclear', reason: 'Не хватает данных для add_position' };
      }
      return { intent: 'add_position', phone, color, size, kind, qty };
    }
    case 'delete_position': {
      const idx = typeof args.positionIndex === 'number' ? args.positionIndex : NaN;
      if (!Number.isFinite(idx) || idx < 1) return { intent: 'unclear', reason: 'Не указан positionIndex' };
      return { intent: 'delete_position', phone, positionIndex: idx };
    }
    case 'show_client': {
      if (!phone) return { intent: 'unclear', reason: 'Не указан телефон' };
      const mode = args.mode === 'receipt' ? 'receipt' : 'card';
      return { intent: 'show_client', phone, mode };
    }
    case 'show_orders': {
      const r: AIIntent = { intent: 'show_orders' };
      if (typeof args.startDate === 'string') r.startDate = args.startDate;
      if (typeof args.endDate === 'string') r.endDate = args.endDate;
      if (typeof args.limit === 'number') r.limit = args.limit;
      if (typeof args.status === 'string') r.status = args.status;
      if (!r.startDate && !r.endDate && !r.limit) {
        return { intent: 'unclear', reason: 'Не указан период' };
      }
      return r;
    }
    case 'show_timeline': {
      if (!args.startDate || !args.endDate) {
        return { intent: 'unclear', reason: 'Не указан период для таймлайна' };
      }
      return { intent: 'show_timeline', startDate: args.startDate, endDate: args.endDate };
    }
    case 'unclear':
    default:
      return { intent: 'unclear', reason: String(args.reason ?? 'Не понял запрос') };
  }
}
