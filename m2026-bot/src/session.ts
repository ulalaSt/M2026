import { SESSION_TTL_SECONDS } from './config';

export type Step =
  | 'idle'
  | 'phone'
  | 'date'
  | 'date_manual'
  | 'pos_kind'
  | 'pos_color'
  | 'pos_size'
  | 'pos_qty'
  | 'pos_more'
  | 'extras'
  | 'ext_school_choice'
  | 'ext_school'
  | 'ext_time'
  | 'ext_price'
  | 'ext_paid'
  | 'ext_discount'
  | 'ext_note'
  | 'confirm'
  | 'edit_menu'
  | 'edit_phone'
  | 'edit_date'
  | 'edit_date_manual'
  | 'edit_school_choice'
  | 'edit_school'
  | 'edit_time'
  | 'edit_price'
  | 'edit_paid'
  | 'edit_discount'
  | 'edit_note'
  | 'edit_positions'
  | 'edit_pos_kind'
  | 'edit_pos_color'
  | 'edit_pos_size'
  | 'edit_pos_qty'
  | 'status_query'
  | 'status_delete_confirm'
  | 'orders_day_input'
  | 'orders_range_start'
  | 'orders_range_end'
  | 'edit_confirm'
  | 'edit_pick_position';

export type DraftPosition = {
  color?: string;
  size?: string;
  kind?: string;
  qty?: number;
};

export type DraftClient = {
  phone?: string;
  school?: string;
  address?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  price?: number;
  paid?: number;
  discount?: number;
  note?: string;
  positions: DraftPosition[];
};

export type PendingOp =
  | { type: 'update_client'; changes: Record<string, any> }
  | { type: 'update_position'; positionPageId: string; changes: Record<string, any> }
  | { type: 'add_position'; pos: DraftPosition }
  | { type: 'archive_position'; positionPageId: string };

export type PendingEdit = {
  clientPageId: string;
  description: string;
  operations: PendingOp[];
  usageLine?: string;
};

export type PendingChange = {
  type: 'update_positions';
  phone: string;
  match: { color?: string; size?: string; kind?: string };
  newColor?: string;
  newSize?: string;
  newKind?: string;
  newQty?: number;
  splitQty?: number;
};

export type Session = {
  step: Step;
  draft: DraftClient;
  currentPosition?: DraftPosition;
  selectedPageId?: string;
  selectedPhone?: string;
  editingPageId?: string;
  rangeStart?: string;
  pendingEdit?: PendingEdit;
  positionCandidates?: { positionPageId: string; label: string }[];
  pendingChange?: PendingChange;
  aiThread?: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    expiresAt: number;
  };
  aiPickContext?: {
    text: string;
    expiresAt: number;
  };
};

const EMPTY_DRAFT: DraftClient = { positions: [] };

export function emptySession(): Session {
  return { step: 'idle', draft: { ...EMPTY_DRAFT, positions: [] } };
}

export async function getSession(kv: KVNamespace, userId: number): Promise<Session> {
  const raw = await kv.get<Session>(`session:${userId}`, 'json');
  return raw ?? emptySession();
}

export async function saveSession(
  kv: KVNamespace,
  userId: number,
  session: Session,
): Promise<void> {
  await kv.put(`session:${userId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function clearSession(kv: KVNamespace, userId: number): Promise<void> {
  await kv.delete(`session:${userId}`);
}
