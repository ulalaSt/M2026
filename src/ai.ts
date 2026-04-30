import { Schema } from './schema';

export type AIIntent =
  | { intent: 'change_date'; phone: string; newDate: string }
  | { intent: 'change_status'; phone: string; newStatus: string }
  | { intent: 'change_payment'; phone: string; addPaid?: number; setPaid?: number }
  | { intent: 'change_note'; phone: string; note: string }
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
  | { intent: 'unclear'; reason: string };

const FUNCTION_DECLARATION = {
  name: 'register_intent',
  description: 'Зарегистрировать намерение пользователя по редактированию клиента',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['change_date', 'change_status', 'change_payment', 'change_note', 'change_position', 'add_position', 'unclear'],
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
      color: { type: 'string' },
      size: { type: 'string' },
      kind: { type: 'string' },
      qty: { type: 'number' },
      reason: { type: 'string', description: 'Объяснение если intent=unclear' },
    },
    required: ['intent'],
  },
};

function buildSystemPrompt(schema: Schema): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Ты помощник для редактирования клиентов в базе мантий. Извлекай намерение из сообщения и вызывай функцию register_intent.

Сегодня: ${today}.

Доступные значения:
- statuses: ${schema.statuses.join(', ')}
- colors: ${schema.colors.join(', ')}
- sizes: ${schema.sizes.join(', ')}
- kinds: ${schema.kinds.join(', ')}

Правила:
- "забрал" / "получил" / "выполнен" / "выдан" → status=ЗАБРАЛИ
- "вернул" / "возврат" → status=ВЕРНУЛИ
- "бронь" → status=БРОНЬ
- "оплатил ещё N" / "доплатил N" → addPaid=N (НЕ setPaid)
- "оплатил всего N" / "оплачено N" → setPaid=N
- "добавь N <цвет> <размер>" → add_position с qty=N
- "поменяй <старое> на <новое>" → change_position с positionMatch (что было) и newX (что станет)
- "перенеси на <дата>" / "поменяй дату на <дата>" → change_date (формат YYYY-MM-DD)
- Если телефон не указан явно — phone=""
- Используй ТОЛЬКО значения из списков выше. Никогда не придумывай новых статусов/цветов/размеров/видов.
- Если непонятно или не хватает данных — intent=unclear с reason.`;
}

export async function parseIntent(apiKey: string, userMessage: string, schema: Schema): Promise<AIIntent> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(schema) }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    tools: [{ functionDeclarations: [FUNCTION_DECLARATION] }],
    toolConfig: {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['register_intent'] },
    },
    generationConfig: { temperature: 0, maxOutputTokens: 500 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const fn = parts.find((p: any) => p.functionCall)?.functionCall;
  if (!fn || fn.name !== 'register_intent') {
    return { intent: 'unclear', reason: 'Не удалось распознать намерение' };
  }
  return mapToIntent(fn.args ?? {}, schema);
}

function mapToIntent(args: any, schema: Schema): AIIntent {
  const intent = args.intent as string;
  const phone = String(args.phone ?? '');
  const validate = (val: string | undefined, list: string[]): string | undefined => {
    if (!val) return undefined;
    return list.includes(val) ? val : undefined;
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
    case 'unclear':
    default:
      return { intent: 'unclear', reason: String(args.reason ?? 'Не понял запрос') };
  }
}
