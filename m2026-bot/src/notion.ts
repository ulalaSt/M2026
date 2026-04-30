import { Client } from '@notionhq/client';
import { dbIds } from './config';
import { DraftClient, DraftPosition } from './session';

export type CreatedClient = {
  pageId: string;
  url: string;
  positionsCount: number;
};

/**
 * Создаёт страницу клиента в М2026 + страницы позиций в базе Позиция,
 * связывая их через relation. Возвращает URL созданного клиента.
 */
export async function createClientWithPositions(
  notion: Client,
  draft: DraftClient,
): Promise<CreatedClient> {
  // 1. Создаём клиента
  const clientProps: Record<string, any> = {
    'НОМЕР': {
      title: [{ type: 'text', text: { content: draft.phone ?? '' } }],
    },
    'СТАТУС': { select: { name: 'БРОНЬ' } },
  };

  if (draft.school) clientProps['УЧЕБНОЕ ЗАВЕДЕНИЕ'] = { select: { name: draft.school } };
  if (draft.address) clientProps['АДРЕС'] = { select: { name: draft.address } };
  if (draft.date) {
    const start = draft.time ? `${draft.date}T${draft.time}:00` : draft.date;
    clientProps['ДАТА'] = { date: { start } };
  }
  if (typeof draft.price === 'number') clientProps['ЦЕНА'] = { number: draft.price };
  if (typeof draft.paid === 'number') clientProps['ОПЛАЧЕНО'] = { number: draft.paid };
  if (typeof draft.discount === 'number') clientProps['СКИДКА'] = { number: draft.discount };
  if (draft.note) clientProps['ПРИМЕЧАНИЕ'] = { rich_text: [{ type: 'text', text: { content: draft.note } }] };

  const clientPage = await createPage(notion, dbIds.m2026, clientProps);

  // 2. Создаём позиции параллельно
  const positionPromises = draft.positions
    .filter(p => p.color && p.size && p.kind && p.qty)
    .map(pos => createPage(notion, dbIds.positions, {
      'Название': { title: [{ type: 'text', text: { content: '' } }] },
      'Цвет': { select: { name: pos.color } },
      'Размер': { select: { name: pos.size } },
      'Вид': { select: { name: pos.kind } },
      'Количество': { number: pos.qty },
      'М2026': { relation: [{ id: clientPage.id }] },
    }));
  await Promise.all(positionPromises);

  return {
    pageId: clientPage.id,
    url: clientPage.url ?? `https://notion.so/${clientPage.id.replace(/-/g, '')}`,
    positionsCount: draft.positions.filter(p => p.color && p.size && p.kind && p.qty).length,
  };
}

export type ClientSummary = {
  pageId: string;
  url: string;
  phone: string;
  status?: string;
  school?: string;
  date?: string;
  time?: string;
  price?: number;
  paid?: number;
  discount?: number;
  note?: string;
};

export async function getClient(notion: Client, pageId: string): Promise<ClientSummary> {
  const page: any = await notion.request({ path: `pages/${pageId}`, method: 'get' });
  return parseClientPage(page);
}

export async function searchClients(notion: Client, query: string): Promise<ClientSummary[]> {
  const digits = query.replace(/\D/g, '');
  if (!digits) return [];
  const response: any = await notion.request({
    path: `data_sources/${dbIds.m2026}/query`,
    method: 'post',
    body: {
      filter: { property: 'НОМЕР', title: { contains: digits } },
      page_size: 20,
    },
  });
  return (response.results ?? []).map(parseClientPage);
}

function parseClientPage(page: any): ClientSummary {
  const p = page.properties ?? {};
  const phone = p['НОМЕР']?.title?.[0]?.plain_text ?? '';
  const dateStart = p['ДАТА']?.date?.start as string | undefined;
  let date: string | undefined;
  let time: string | undefined;
  if (dateStart) {
    if (dateStart.includes('T')) {
      const [d, t] = dateStart.split('T');
      date = d;
      time = t.slice(0, 5);
    } else {
      date = dateStart;
    }
  }
  return {
    pageId: page.id,
    url: page.url ?? `https://notion.so/${String(page.id).replace(/-/g, '')}`,
    phone,
    status: p['СТАТУС']?.select?.name,
    school: p['УЧЕБНОЕ ЗАВЕДЕНИЕ']?.select?.name,
    date,
    time,
    price: p['ЦЕНА']?.number ?? undefined,
    paid: p['ОПЛАЧЕНО']?.number ?? undefined,
    discount: p['СКИДКА']?.number ?? undefined,
    note: p['ПРИМЕЧАНИЕ']?.rich_text?.[0]?.plain_text,
  };
}

export async function updateClientStatus(notion: Client, pageId: string, status: string): Promise<void> {
  await notion.request({
    path: `pages/${pageId}`,
    method: 'patch',
    body: { properties: { 'СТАТУС': { select: { name: status } } } },
  });
}

export async function archiveClient(notion: Client, pageId: string): Promise<void> {
  await notion.request({
    path: `pages/${pageId}`,
    method: 'patch',
    body: { archived: true },
  });
}

export async function searchClientsUpcoming(notion: Client, fromISO: string, limit: number): Promise<ClientSummary[]> {
  const response: any = await notion.request({
    path: `data_sources/${dbIds.m2026}/query`,
    method: 'post',
    body: {
      filter: { property: 'ДАТА', date: { on_or_after: fromISO } },
      sorts: [{ property: 'ДАТА', direction: 'ascending' }],
      page_size: Math.max(1, Math.min(limit, 50)),
    },
  });
  return (response.results ?? []).map(parseClientPage);
}

export async function searchClientsByDateRange(notion: Client, startISO: string, endISO: string): Promise<ClientSummary[]> {
  const response: any = await notion.request({
    path: `data_sources/${dbIds.m2026}/query`,
    method: 'post',
    body: {
      filter: {
        and: [
          { property: 'ДАТА', date: { on_or_after: startISO } },
          { property: 'ДАТА', date: { on_or_before: endISO } },
        ],
      },
      sorts: [{ property: 'ДАТА', direction: 'ascending' }],
      page_size: 100,
    },
  });
  return (response.results ?? []).map(parseClientPage);
}

export async function loadClientPositions(notion: Client, clientPageId: string): Promise<DraftPosition[]> {
  const response: any = await notion.request({
    path: `data_sources/${dbIds.positions}/query`,
    method: 'post',
    body: {
      filter: { property: 'М2026', relation: { contains: clientPageId } },
      page_size: 100,
    },
  });
  return (response.results ?? []).map((page: any) => {
    const p = page.properties ?? {};
    return {
      color: p['Цвет']?.select?.name,
      size: p['Размер']?.select?.name,
      kind: p['Вид']?.select?.name,
      qty: p['Количество']?.number ?? undefined,
    } as DraftPosition;
  });
}

export async function updateClientFull(notion: Client, pageId: string, draft: DraftClient): Promise<void> {
  const props: Record<string, any> = {
    'НОМЕР': { title: [{ type: 'text', text: { content: draft.phone ?? '' } }] },
  };
  if (draft.school) props['УЧЕБНОЕ ЗАВЕДЕНИЕ'] = { select: { name: draft.school } };
  else props['УЧЕБНОЕ ЗАВЕДЕНИЕ'] = { select: null };
  if (draft.date) {
    const start = draft.time ? `${draft.date}T${draft.time}:00` : draft.date;
    props['ДАТА'] = { date: { start } };
  } else {
    props['ДАТА'] = { date: null };
  }
  props['ЦЕНА'] = typeof draft.price === 'number' ? { number: draft.price } : { number: null };
  props['ОПЛАЧЕНО'] = typeof draft.paid === 'number' ? { number: draft.paid } : { number: null };
  props['СКИДКА'] = typeof draft.discount === 'number' ? { number: draft.discount } : { number: null };
  props['ПРИМЕЧАНИЕ'] = draft.note
    ? { rich_text: [{ type: 'text', text: { content: draft.note } }] }
    : { rich_text: [] };

  await notion.request({
    path: `pages/${pageId}`,
    method: 'patch',
    body: { properties: props },
  });

  // Архивируем существующие позиции и создаём новые
  const existing: any = await notion.request({
    path: `data_sources/${dbIds.positions}/query`,
    method: 'post',
    body: {
      filter: { property: 'М2026', relation: { contains: pageId } },
      page_size: 100,
    },
  });
  await Promise.all((existing.results ?? []).map((pg: any) =>
    notion.request({ path: `pages/${pg.id}`, method: 'patch', body: { archived: true } }),
  ));

  await Promise.all(
    draft.positions
      .filter(p => p.color && p.size && p.kind && p.qty)
      .map(pos => createPage(notion, dbIds.positions, {
        'Название': { title: [{ type: 'text', text: { content: '' } }] },
        'Цвет': { select: { name: pos.color } },
        'Размер': { select: { name: pos.size } },
        'Вид': { select: { name: pos.kind } },
        'Количество': { number: pos.qty },
        'М2026': { relation: [{ id: pageId }] },
      })),
  );
}

// --- AI-edit helpers ---

export type FoundPosition = {
  pageId: string;
  color?: string;
  size?: string;
  kind?: string;
  qty?: number;
  label?: string; // формула «Позиция» из Notion (например "🟢 И-2L")
};

export type FoundClient = {
  pageId: string;
  url: string;
  phone: string;
  school?: string;
  address?: string;
  date?: string;
  status?: string;
  price?: number;
  paid?: number;
  discount?: number;
  note?: string;
  positions: FoundPosition[];
};

export function extractTitle(p: any, key: string): string | undefined {
  return p?.[key]?.title?.[0]?.plain_text;
}
export function extractRichText(p: any, key: string): string | undefined {
  return p?.[key]?.rich_text?.[0]?.plain_text;
}
export function extractSelect(p: any, key: string): string | undefined {
  return p?.[key]?.select?.name;
}
export function extractNumber(p: any, key: string): number | undefined {
  const n = p?.[key]?.number;
  return typeof n === 'number' ? n : undefined;
}
export function extractDate(p: any, key: string): string | undefined {
  const start = p?.[key]?.date?.start as string | undefined;
  if (!start) return undefined;
  return start.includes('T') ? start.split('T')[0] : start;
}
export function extractFormulaString(p: any, key: string): string | undefined {
  const f = p?.[key]?.formula;
  if (!f) return undefined;
  if (f.type === 'string') return f.string;
  if (f.type === 'number') return String(f.number);
  return undefined;
}

/** Берёт первое свойство типа formula с непустым string-значением. */
export function extractAnyFormula(props: any): string | undefined {
  for (const key of Object.keys(props ?? {})) {
    const v = props[key];
    if (v?.type === 'formula' && v.formula?.type === 'string' && v.formula.string) {
      return v.formula.string;
    }
  }
  return undefined;
}

export async function findClientsByPhone(notion: Client, phone: string): Promise<FoundClient[]> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return [];
  const last10 = digits.slice(-10);
  const last7 = digits.slice(-7);
  const response: any = await notion.request({
    path: `data_sources/${dbIds.m2026}/query`,
    method: 'post',
    body: {
      filter: { property: 'НОМЕР', title: { contains: last7 } },
      page_size: 20,
    },
  });
  const candidates = (response.results ?? []).filter((page: any) => {
    const t = extractTitle(page.properties, 'НОМЕР') ?? '';
    return t.replace(/\D/g, '').endsWith(last10);
  });
  const positionsByClient = await Promise.all(
    candidates.map((page: any) => getPositionsForClient(notion, page.id)),
  );
  return candidates.map((page: any, i: number): FoundClient => {
    const p = page.properties ?? {};
    return {
      pageId: page.id,
      url: page.url ?? `https://notion.so/${String(page.id).replace(/-/g, '')}`,
      phone: extractTitle(p, 'НОМЕР') ?? '',
      school: extractSelect(p, 'УЧЕБНОЕ ЗАВЕДЕНИЕ'),
      address: extractSelect(p, 'АДРЕС'),
      date: extractDate(p, 'ДАТА'),
      status: extractSelect(p, 'СТАТУС'),
      price: extractNumber(p, 'ЦЕНА'),
      paid: extractNumber(p, 'ОПЛАЧЕНО'),
      discount: extractNumber(p, 'СКИДКА'),
      note: extractRichText(p, 'ПРИМЕЧАНИЕ'),
      positions: positionsByClient[i],
    };
  });
}

export async function getPositionsForClient(notion: Client, clientPageId: string): Promise<FoundPosition[]> {
  const response: any = await notion.request({
    path: `data_sources/${dbIds.positions}/query`,
    method: 'post',
    body: {
      filter: { property: 'М2026', relation: { contains: clientPageId } },
      page_size: 100,
    },
  });
  return (response.results ?? []).map((page: any) => {
    const p = page.properties ?? {};
    return {
      pageId: page.id,
      color: extractSelect(p, 'Цвет'),
      size: extractSelect(p, 'Размер'),
      kind: extractSelect(p, 'Вид'),
      qty: extractNumber(p, 'Количество'),
      label: extractFormulaString(p, 'Позиция') ?? extractFormulaString(p, 'Название') ?? extractAnyFormula(p),
    };
  });
}

/** changes: { date?: 'YYYY-MM-DD'|null, status?: string, paid?: number, note?: string|null } */
export async function updateClientPage(notion: Client, pageId: string, changes: Record<string, any>): Promise<void> {
  const props: Record<string, any> = {};
  if ('date' in changes) {
    props['ДАТА'] = changes.date ? { date: { start: changes.date } } : { date: null };
  }
  if ('status' in changes && changes.status) {
    props['СТАТУС'] = { select: { name: changes.status } };
  }
  if ('school' in changes) {
    props['УЧЕБНОЕ ЗАВЕДЕНИЕ'] = changes.school ? { select: { name: changes.school } } : { select: null };
  }
  if ('paid' in changes && typeof changes.paid === 'number') {
    props['ОПЛАЧЕНО'] = { number: changes.paid };
  }
  if ('note' in changes) {
    props['ПРИМЕЧАНИЕ'] = changes.note
      ? { rich_text: [{ type: 'text', text: { content: changes.note } }] }
      : { rich_text: [] };
  }
  if (Object.keys(props).length === 0) return;
  await notion.request({ path: `pages/${pageId}`, method: 'patch', body: { properties: props } });
}

export async function updatePositionPage(notion: Client, pageId: string, changes: Record<string, any>): Promise<void> {
  const props: Record<string, any> = {};
  if (changes.color) props['Цвет'] = { select: { name: changes.color } };
  if (changes.size) props['Размер'] = { select: { name: changes.size } };
  if (changes.kind) props['Вид'] = { select: { name: changes.kind } };
  if (typeof changes.qty === 'number') props['Количество'] = { number: changes.qty };
  if (Object.keys(props).length === 0) return;
  await notion.request({ path: `pages/${pageId}`, method: 'patch', body: { properties: props } });
}

export async function archivePosition(notion: Client, positionPageId: string): Promise<void> {
  await notion.request({ path: `pages/${positionPageId}`, method: 'patch', body: { archived: true } });
}

export async function addPositionToClient(notion: Client, clientPageId: string, pos: DraftPosition): Promise<void> {
  if (!pos.color || !pos.size || !pos.kind || !pos.qty) return;
  await createPage(notion, dbIds.positions, {
    'Название': { title: [{ type: 'text', text: { content: '' } }] },
    'Цвет': { select: { name: pos.color } },
    'Размер': { select: { name: pos.size } },
    'Вид': { select: { name: pos.kind } },
    'Количество': { number: pos.qty },
    'М2026': { relation: [{ id: clientPageId }] },
  });
}

async function createPage(
  notion: Client,
  dataSourceId: string,
  properties: Record<string, any>,
): Promise<{ id: string; url?: string }> {
  const response = await notion.request({
    path: 'pages',
    method: 'post',
    body: {
      parent: { data_source_id: dataSourceId },
      properties,
    },
  });
  return response as { id: string; url?: string };
}
