import { Schema } from './schema';

export type AIIntent =
  | { intent: 'change_date'; phone: string; newDate: string }
  | { intent: 'change_status'; phone: string; newStatus: string }
  | { intent: 'change_payment'; phone: string; addPaid?: number; setPaid?: number }
  | { intent: 'change_note'; phone: string; note: string }
  | { intent: 'change_school'; phone: string; newSchool: string }
  | {
      intent: 'change_position';
      phone: string;
      positionMatch: { color?: string; size?: string; kind?: string };
      newColor?: string;
      newSize?: string;
      newKind?: string;
      newQty?: number;
    }
  | { intent: 'add_position'; phone: string; color: string; size: string; kind: string; qty: number }
  | {
      intent: 'split_position';
      phone: string;
      positionMatch: { color?: string; size?: string; kind?: string };
      qty: number;
      newColor?: string;
      newSize?: string;
      newKind?: string;
    }
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
        enum: ['change_date', 'change_status', 'change_payment', 'change_note', 'change_school', 'change_position', 'add_position', 'split_position', 'show_client', 'show_orders', 'show_timeline', 'unclear'],
        description: 'Тип действия',
      },
      phone: { type: 'string', description: 'Телефон клиента или пустая строка если не указан' },
      newDate: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
      newStatus: { type: 'string', description: 'Новый статус (точно из списка)' },
      addPaid: { type: 'number', description: 'Сколько добавить к оплате' },
      setPaid: { type: 'number', description: 'Установить оплачено в это значение' },
      note: { type: 'string', description: 'Текст примечания' },
      positionMatch: {
        type: 'object',
        properties: {
          color: { type: 'string' },
          size: { type: 'string' },
          kind: { type: 'string' },
        },
      },
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
- "поменяй <старое> на <новое>" / каз. "<старое>-ны <новое>-ға ауыстыр" БЕЗ количества → change_position
- "поменяй N <старое> на <новое>" / "перенеси N" / "разбей N" / каз. "N <старое>-ны <новое>-ға ауыстыр" → split_position. positionMatch — откуда, newX — что меняется, qty — сколько.
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
- Телефон может быть полным (87771112233, +77771112233) или последними 4-7 цифрами (например "2233", "112233"). Передавай как есть в phone — поиск сам найдёт.
- Если телефон не указан вообще — phone=""
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

export async function parseIntent(apiKey: string, userMessage: string, schema: Schema): Promise<AIResult> {
  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    temperature: 0,
    system: buildSystemPrompt(schema),
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'register_intent' },
    messages: [{ role: 'user', content: userMessage }],
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
  const block = (json?.content ?? []).find((c: any) => c.type === 'tool_use' && c.name === 'register_intent');
  if (!block) {
    return { intent: { intent: 'unclear', reason: 'Не удалось распознать намерение' }, usage };
  }
  return { intent: mapToIntent(block.input ?? {}, schema), usage };
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
    case 'change_position': {
      const m = args.positionMatch ?? {};
      const match = {
        color: validate(m.color, schema.colors),
        size: validate(m.size, schema.sizes),
        kind: validate(m.kind, schema.kinds),
      };
      const newColor = validate(args.newColor, schema.colors);
      const newSize = validate(args.newSize, schema.sizes);
      const newKind = validate(args.newKind, schema.kinds);
      const newQty = typeof args.newQty === 'number' ? args.newQty : undefined;
      if (!match.color && !match.size && !match.kind) {
        return { intent: 'unclear', reason: 'Не указано какую позицию менять' };
      }
      if (!newColor && !newSize && !newKind && newQty === undefined) {
        return { intent: 'unclear', reason: 'Не указано на что менять' };
      }
      return { intent: 'change_position', phone, positionMatch: match, newColor, newSize, newKind, newQty };
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
    case 'split_position': {
      const m = args.positionMatch ?? {};
      const match = {
        color: validate(m.color, schema.colors),
        size: validate(m.size, schema.sizes),
        kind: validate(m.kind, schema.kinds),
      };
      const newColor = validate(args.newColor, schema.colors);
      const newSize = validate(args.newSize, schema.sizes);
      const newKind = validate(args.newKind, schema.kinds);
      const qty = typeof args.qty === 'number' ? args.qty : undefined;
      if (!match.color && !match.size && !match.kind) {
        return { intent: 'unclear', reason: 'Не указано какую позицию делить' };
      }
      if (!newColor && !newSize && !newKind) {
        return { intent: 'unclear', reason: 'Не указано на что менять часть позиции' };
      }
      if (!qty || qty <= 0) {
        return { intent: 'unclear', reason: 'Не указано сколько штук переносить' };
      }
      return { intent: 'split_position', phone, positionMatch: match, qty, newColor, newSize, newKind };
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
