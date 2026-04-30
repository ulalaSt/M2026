export type Schema = {
  schools: string[];
  addresses: string[];
  statuses: string[];
  colors: string[];
  sizes: string[];
  kinds: string[];
};

export type DraftPosition = {
  color: string;
  size: string;
  kind: string;
  qty: number;
};

export type DraftClient = {
  phone: string;
  school?: string;
  address?: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM
  price?: number;
  paid?: number;
  discount?: number;
  note?: string;
  positions: DraftPosition[];
};

export type CreatedClient = {
  pageId: string;
  url: string;
  positionsCount: number;
};
