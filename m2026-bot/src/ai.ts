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
      positionId: string; // pageId позиции из контекста
      newColor?: string;
      newSize?: string;
      newKind?: string;
      newQty?: number;
    }
  | { intent: 'add_position'; phone: string; color: string; size: string; kind: string; qty: number }
  | { intent: 'delete_position'; phone: string; positionId: string }
  | {
      intent: 'create_client';
      phone: string;
      school?: string;
      date?: string;
      time?: string;
      price?: number;
      paid?: number;
      discount?: number;
      note?: string;
      positions: Array<{ color: string; size: string; kind: string; qty: number }>;
    }
  | { intent: 'show_client'; phone: string; mode?: 'card' | 'receipt' }
  | {
      intent: 'query_orders';
      clientFilter?: any; // Notion-фильтр для М2026 (см. промпт)
      positionFilter?: { color?: string; size?: string; kind?: string }; // фильтр позиций
      sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>;
      limit?: number;
      view?: 'list' | 'timeline';
      title?: string; // заголовок выдачи (например "Заказы на май")
    }
  | { intent: 'unclear'; reason: string };

const ACTION_PROPERTIES = {
  intent: {
    type: 'string',
    enum: ['update_client', 'update_position', 'add_position', 'delete_position', 'create_client', 'show_client', 'query_orders', 'unclear'],
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
  positionId: { type: 'string', description: 'ID позиции из контекста клиента (поле id=...)' },
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
  clientFilter: { type: 'object', description: 'Notion-фильтр для базы М2026 (см. описание полей и операторов в промпте)' },
  positionFilter: {
    type: 'object',
    description: 'Фильтр позиций (опционально). Если задан, оставит только клиентов у которых есть хотя бы одна подходящая позиция.',
    properties: {
      color: { type: 'string' },
      size: { type: 'string' },
      kind: { type: 'string' },
    },
  },
  sorts: { type: 'array', description: 'Notion sorts: [{property, direction}]', items: { type: 'object' } },
  view: { type: 'string', enum: ['list', 'timeline'], description: 'list = плоский список, timeline = по дням' },
  title: { type: 'string', description: 'Заголовок выдачи для пользователя (например "Заказы на май")' },
  positions: {
    type: 'array',
    description: 'Массив позиций для create_client',
    items: {
      type: 'object',
      properties: {
        color: { type: 'string' },
        size: { type: 'string' },
        kind: { type: 'string' },
        qty: { type: 'number' },
      },
    },
  },
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
- update_client — поля клиента: date, time, school, status, addPaid (прибавить к оплачено), setPaid (поставить точно), discount, note.
- update_position — изменить ОДНУ позицию по positionId (бери поле id=... из списка в контексте) + newColor/newSize/newKind/newQty.
- add_position — добавить новую позицию: color, size, kind, qty.
- delete_position — удалить позицию по positionId.
- create_client — создать НОВОГО клиента (используй только когда в контексте указано «Клиент не найден»): phone, школа/дата/время/цена/оплачено/скидка/примечание (опционально), positions[] — массив объектов {color, size, kind, qty} (хотя бы 1).
- show_client (mode='card'|'receipt').
- query_orders — поиск/фильтрация заказов. Ты сам строишь Notion-фильтр.

  Схема базы М2026 (используй ТОЧНЫЕ имена свойств):
  - "НОМЕР" (title) — телефон клиента
  - "УЧЕБНОЕ ЗАВЕДЕНИЕ" (select) — из schools
  - "АДРЕС" (select) — из addresses
  - "ДАТА" (date) — дата выдачи
  - "СТАТУС" (select) — из statuses
  - "ЦЕНА" (number), "ОПЛАЧЕНО" (number), "СКИДКА" (number)
  - "ПРИМЕЧАНИЕ" (rich_text)

  Notion-операторы:
  - select: { equals, does_not_equal, is_empty, is_not_empty }
  - date: { equals, before, after, on_or_before, on_or_after, is_empty, is_not_empty }
  - number: { equals, does_not_equal, greater_than, less_than, greater_than_or_equal_to, less_than_or_equal_to, is_empty, is_not_empty }
  - rich_text/title: { contains, does_not_contain, equals, is_empty, is_not_empty }
  - Объединяй через { "and": [...] } или { "or": [...] }.

  Формат фильтра — clientFilter, например:
  - Заказы на май: { "and": [{"property":"ДАТА","date":{"on_or_after":"2026-05-01"}},{"property":"ДАТА","date":{"on_or_before":"2026-05-31"}}] }
  - Кто забрал: { "property":"СТАТУС","select":{"equals":"ЗАБРАЛИ"} }
  - Заказы школы Болашақ: { "property":"УЧЕБНОЕ ЗАВЕДЕНИЕ","select":{"equals":"Болашақ"} }

  positionFilter — отдельный фильтр для базы Позиция (применяется в памяти после загрузки):
  - { "color":"🟢 зелёный" } — только клиенты у которых есть зелёная позиция
  - { "kind":"Садик" } — только заказы с садиковскими мантиями
  - { "size":"M" }, либо комбинация color+size+kind

  sorts — например [{"property":"ДАТА","direction":"ascending"}]
  limit — для "первые N" / "ближайший" (limit=1)
  view = 'timeline' для запросов «по дням», «таймлайн», «календарь»; иначе 'list'
  title — короткий заголовок для пользователя (опционально), например "Заказы на май" или "Синие на эту неделю".

  Примеры query_orders:
  - "покажи сегодняшние заказы" → clientFilter={"property":"ДАТА","date":{"equals":"${today}"}}, view='list'
  - "на эту неделю" → диапазон today..(today+6 дней), view='list' или 'timeline' для "по дням"
  - "на май" → 2026-05-01..2026-05-31, view='list'
  - "синие на май" → clientFilter=диапазон мая, positionFilter={color:"🔵 синий"}
  - "кто забрали" → clientFilter={property:"СТАТУС",select:{equals:"ЗАБРАЛИ"}}
  - "заказы на садик" → positionFilter={kind:"Садик"} (без clientFilter — все клиенты с садиковскими позициями)
  - "ближайший заказ" → clientFilter={property:"ДАТА",date:{on_or_after:"${today}"}}, sorts=[{property:"ДАТА",direction:"ascending"}], limit=1

- unclear (reason).

ГЛАВНЫЙ ПРИНЦИП: видишь актуальный список позиций клиента в контексте. Сам решай по ним — пользователь говорит на естественном языке, не по индексам.

Жаргон и правила:
- "+N <вид> <размер> <цвет>" / "+1 студент" / "ещё 5 детских" → add_position. Если каких-то атрибутов нет — бери из существующих позиций клиента (например "+1 студент стандарт тот же цвет" → color совпадает с цветом существующих позиций; "стандарт"=M).
- "-N человека" / "-2 шт" → уменьшить на N. Если 1 подходящая позиция → update_position c newQty=qty-N. Если станет 0 → delete_position.
- "поменяй на <X>" / "все берут <X>" / "все на <X>" → меняем у ВСЕХ подходящих позиций (массив update_position). "все берут стандарт"=newSize=M для всех. "поменяй на красный"=newColor=красный для всех.
- "<N> человек поменяли/решили взять <Y>" / "<N> на <Y>" → split: одна позиция-источник (бери самую большую подходящую), update_position { newQty: qty-N } + add_position { ...атрибуты источника, перезаписываем чем поменяли, qty=N }.
- "убрать <X>" / "удалить <X>" → delete_position для всех совпадающих.
- "стандарт"="M", "маленький"="S", "большой"="L".
- "студент"="Взрослый". "школьник"="Детский". "малыш"/"садик"="Садик".

Примеры (контекст: позиции id=A1 🟢 зелёный M Взрослый ×10, id=B2 🟢 зелёный L Взрослый ×8):
- "5566 поменяй на красный цвет" → 2 update_position: positionId=A1 newColor=🔴, positionId=B2 newColor=🔴.
- "5566 4 человека поменяли на маленький" → 2 действия: update_position positionId=A1 newQty=6, add_position {🟢 S Взрослый ×4}.
- "5566 -2 человека" → 1 update_position у позиции с большим qty (positionId=A1) newQty=8.
- "5566 +1 студент" — есть позиции → add_position { цвет/размер с самой большой, kind=Взрослый, qty=1 }.
- "5566 все берут стандарт" → update_position для тех у кого size != M.
- "5566 +1 детский стандарт тот же цвет" → add_position {🟢 M Детский ×1}.
- "5566 убрать детский" → delete_position positionId=... для всех с kind=Детский.
- "5566 5 решили взять синий" → update_position positionId=A1 newQty=5, add_position {🔵 M Взрослый ×5}.

ВАЖНО:
- ДЕЙСТВУЙ когда ответ можно вывести из контекста, НЕ ЗАДАВАЙ ВОПРОС. Если у клиента все позиции одного цвета/вида и пользователь добавляет позицию без указания цвета/вида — просто бери эти значения. Если в команде несколько действий через "и"/запятую — возвращай массив.
- Позиции уникальны по тройке (color, size, kind). НЕ создавай add_position если уже есть такая — вместо этого делай update_position с newQty = текущее + N. Аналогично, если update_position приведёт к совпадению с другой существующей по (color,size,kind) — объединяй: одну update_position поднять до суммы, другую delete_position.
- Если есть выбор какой источник для split/уменьшения — бери самую большую по qty подходящую позицию.
- Если есть выбор куда применить (несколько подходят) — применяй ко всем.
- Уточняющий вопрос задавай ТОЛЬКО если ну никак не вывести — например "+1 студент" без позиций у клиента, или цвета у разных позиций различаются и невозможно понять какой брать.
- Не выдумывай цвета/размеры/виды — только из списков выше.
- Оплата: "оплатил ещё N / доплатил N" / "тағы N төледі" → addPaid=N. "оплатил всего N / оплачено N" / "барлығы N төленді" → setPaid=N. "оплатил полностью / закрыл оплату / всё оплачено" / "толығымен төледі" → addPaid = «Остаток к оплате» из контекста. ВАЖНО: если в этом же ответе ты добавляешь/меняешь позиции — пересчитай сумму с учётом новых qty (Сумма = Цена × сумма всех qty после твоих изменений; Остаток = Сумма − текущее Оплачено − Скидка).

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

/** fetch с ретраями на 429/529/5xx (Anthropic overloaded и rate limit). */
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastResp: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, init);
    lastResp = resp;
    if (resp.ok) return resp;
    if (resp.status !== 429 && resp.status !== 529 && resp.status < 500) return resp;
    if (attempt === maxAttempts) return resp;
    // backoff: 500ms, 1500ms, 4500ms
    const delay = 500 * Math.pow(3, attempt - 1);
    console.warn(`[AI retry ${attempt}/${maxAttempts}] status=${resp.status}, ждём ${delay}мс`);
    await new Promise(r => setTimeout(r, delay));
  }
  return lastResp!;
}

export type ParseResult =
  | { kind: 'actions'; actions: AIIntent[]; usage: Usage }
  | { kind: 'question'; text: string; usage: Usage };

/** Извлекает «телефонную» строку из произвольного текста. */
export function extractPhoneFromText(text: string): string | null {
  const candidates: string[] = [];
  // Длинный телефон с пробелами/разделителями (≥10 цифр)
  for (const m of text.match(/\+?\d[\d\s\-()]{8,}\d/g) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 10) candidates.push(d);
  }
  // Короткий с дефисами (без пробелов): "55-55", "12-34"
  for (const m of text.match(/\d[\d\-]{2,}\d/g) ?? []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 4) candidates.push(d);
  }
  // Просто 4+ подряд идущих цифр
  for (const m of text.match(/\d{4,}/g) ?? []) {
    candidates.push(m);
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => b.length > a.length ? b : a);
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
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
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
      const id = typeof args.positionId === 'string' ? args.positionId.trim() : '';
      if (!id) return { intent: 'unclear', reason: 'Не указан positionId' };
      const newColor = validate(args.newColor, schema.colors);
      const newSize = validate(args.newSize, schema.sizes);
      const newKind = validate(args.newKind, schema.kinds);
      const newQty = typeof args.newQty === 'number' ? args.newQty : undefined;
      if (!newColor && !newSize && !newKind && newQty === undefined) {
        return { intent: 'unclear', reason: 'Не указано что менять у позиции' };
      }
      return { intent: 'update_position', phone, positionId: id, newColor, newSize, newKind, newQty };
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
      const id = typeof args.positionId === 'string' ? args.positionId.trim() : '';
      if (!id) return { intent: 'unclear', reason: 'Не указан positionId' };
      return { intent: 'delete_position', phone, positionId: id };
    }
    case 'create_client': {
      if (!phone) return { intent: 'unclear', reason: 'Для создания нужен телефон' };
      const positionsRaw = Array.isArray(args.positions) ? args.positions : [];
      const positions: Array<{ color: string; size: string; kind: string; qty: number }> = [];
      for (const p of positionsRaw) {
        const color = validate(p?.color, schema.colors);
        const size = validate(p?.size, schema.sizes);
        const kind = validate(p?.kind, schema.kinds);
        const qty = typeof p?.qty === 'number' ? p.qty : NaN;
        if (color && size && kind && Number.isFinite(qty) && qty > 0) {
          positions.push({ color, size, kind, qty });
        }
      }
      if (positions.length === 0) {
        return { intent: 'unclear', reason: 'Нужна хотя бы одна позиция (цвет/размер/вид/кол-во)' };
      }
      const r: any = { intent: 'create_client', phone, positions };
      if (typeof args.date === 'string') r.date = args.date;
      if (typeof args.time === 'string') r.time = args.time;
      const school = validateFuzzy(args.school, schema.schools);
      if (school) r.school = school;
      if (typeof args.price === 'number') r.price = args.price;
      if (typeof args.paid === 'number') r.paid = args.paid;
      if (typeof args.discount === 'number') r.discount = args.discount;
      if (typeof args.note === 'string') r.note = args.note;
      return r;
    }
    case 'show_client': {
      if (!phone) return { intent: 'unclear', reason: 'Не указан телефон' };
      const mode = args.mode === 'receipt' ? 'receipt' : 'card';
      return { intent: 'show_client', phone, mode };
    }
    case 'query_orders': {
      const r: any = { intent: 'query_orders' };
      if (args.clientFilter && typeof args.clientFilter === 'object') r.clientFilter = args.clientFilter;
      if (args.positionFilter && typeof args.positionFilter === 'object') {
        const pf: any = {};
        if (args.positionFilter.color) pf.color = validate(args.positionFilter.color, schema.colors);
        if (args.positionFilter.size) pf.size = validate(args.positionFilter.size, schema.sizes);
        if (args.positionFilter.kind) pf.kind = validate(args.positionFilter.kind, schema.kinds);
        if (pf.color || pf.size || pf.kind) r.positionFilter = pf;
      }
      if (Array.isArray(args.sorts)) r.sorts = args.sorts;
      if (typeof args.limit === 'number') r.limit = args.limit;
      if (args.view === 'timeline') r.view = 'timeline';
      else r.view = 'list';
      if (typeof args.title === 'string') r.title = args.title;
      if (!r.clientFilter && !r.positionFilter && !r.limit) {
        return { intent: 'unclear', reason: 'Не указан фильтр для запроса' };
      }
      return r;
    }
    case 'unclear':
    default:
      return { intent: 'unclear', reason: String(args.reason ?? 'Не понял запрос') };
  }
}
