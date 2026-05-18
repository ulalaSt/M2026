// ID баз данных в Notion. Значения по умолчанию — продакшн.
// Их можно переопределить через env-переменные в wrangler.toml (M2026_DATA_SOURCE_ID, POSITIONS_DATA_SOURCE_ID).
export const dbIds = {
  m2026: '35164daf-6c5b-8168-916c-000b1340abf2',
  positions: '5ec8589d-2ffc-4584-8955-eba580cc10f6',
};

export function setDbIds(m2026?: string, positions?: string): void {
  if (m2026) dbIds.m2026 = m2026;
  if (positions) dbIds.positions = positions;
}

// Telegram user IDs, которым разрешено пользоваться ботом
export const ALLOWED_USER_IDS = [
  687463957, // основной владелец
  848831101, // @aleke021121
];

// Кэш select-опций живёт в KV столько секунд
export const SCHEMA_CACHE_TTL_SECONDS = 300; // 5 минут

// Сессия пользователя в KV живёт столько секунд (если бросил диалог)
export const SESSION_TTL_SECONDS = 60 * 60; // 1 час
