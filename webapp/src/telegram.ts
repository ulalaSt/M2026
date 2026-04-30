type MainButton = {
  text: string;
  show: () => void;
  hide: () => void;
  setText: (t: string) => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  setParams: (p: { color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
};

type HapticFeedback = {
  notificationOccurred: (kind: 'error' | 'success' | 'warning') => void;
  impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
};

type WebApp = {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string }; auth_date?: number };
  ready: () => void;
  expand: () => void;
  close: () => void;
  themeParams: Record<string, string>;
  colorScheme: 'light' | 'dark';
  MainButton: MainButton;
  HapticFeedback: HapticFeedback;
  showAlert: (msg: string, cb?: () => void) => void;
  showConfirm: (msg: string, cb?: (confirmed: boolean) => void) => void;
  openLink: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

export function getWebApp(): WebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}
