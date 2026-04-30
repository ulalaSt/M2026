import { Client } from '@notionhq/client';
import {
  M2026_DATA_SOURCE_ID,
  POSITIONS_DATA_SOURCE_ID,
  SCHEMA_CACHE_TTL_SECONDS,
} from './config';

export type Schema = {
  schools: string[];   // УЧЕБНОЕ ЗАВЕДЕНИЕ
  addresses: string[]; // АДРЕС
  statuses: string[];  // СТАТУС
  colors: string[];    // Цвет
  sizes: string[];     // Размер
  kinds: string[];     // Вид
  fetchedAt: number;
};

const CACHE_KEY = 'schema:v1';

/**
 * Читает select-опции из Notion. Сначала пытается взять из KV,
 * если кэш свежий — отдаёт его. Иначе обращается в Notion и обновляет кэш.
 */
export async function getSchema(
  notion: Client,
  kv: KVNamespace,
  forceRefresh = false,
): Promise<Schema> {
  if (!forceRefresh) {
    const cached = await kv.get<Schema>(CACHE_KEY, 'json');
    if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_SECONDS * 1000) {
      return cached;
    }
  }

  const fresh = await fetchSchemaFromNotion(notion);
  await kv.put(CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: SCHEMA_CACHE_TTL_SECONDS * 2, // на случай если refresh не сработает
  });
  return fresh;
}

async function fetchSchemaFromNotion(notion: Client): Promise<Schema> {
  // Notion SDK работает через databases.retrieve, но новый API использует
  // dataSources.retrieve. Используем raw request чтобы не зависеть от версии SDK.
  const m2026 = await retrieveDataSource(notion, M2026_DATA_SOURCE_ID);
  const positions = await retrieveDataSource(notion, POSITIONS_DATA_SOURCE_ID);

  return {
    schools: extractSelectOptions(m2026, 'УЧЕБНОЕ ЗАВЕДЕНИЕ'),
    addresses: extractSelectOptions(m2026, 'АДРЕС'),
    statuses: extractSelectOptions(m2026, 'СТАТУС'),
    colors: extractSelectOptions(positions, 'Цвет'),
    sizes: extractSelectOptions(positions, 'Размер'),
    kinds: extractSelectOptions(positions, 'Вид'),
    fetchedAt: Date.now(),
  };
}

async function retrieveDataSource(notion: Client, id: string): Promise<any> {
  return await notion.request({
    path: `data_sources/${id}`,
    method: 'get',
  });
}

function extractSelectOptions(dataSource: any, propertyName: string): string[] {
  const prop = dataSource?.properties?.[propertyName];
  if (!prop) return [];
  if (prop.type === 'select') {
    return prop.select.options.map((o: any) => o.name);
  }
  if (prop.type === 'status') {
    return prop.status.options.map((o: any) => o.name);
  }
  return [];
}
