export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: TelegramWebAppUser;
    start_param?: string;
  };
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  enableClosingConfirmation(): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  openTelegramLink?(url: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export interface DemoIdentity {
  id: string;
  name: string;
  role: 'advertiser' | 'owner';
}

export const demoIdentities: DemoIdentity[] = [
  { id: 'demo-advertiser', name: 'Искандар · рекламодатель', role: 'advertiser' },
  { id: 'demo-owner', name: 'Анна · владелец канала', role: 'owner' },
];

export function telegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function initializeTelegram(): void {
  const app = telegramWebApp();
  if (!app) return;
  app.ready();
  app.expand();
  app.setHeaderColor('#f4b942');
  app.setBackgroundColor('#f6f5f1');
  app.enableClosingConfirmation();
}

export function isInsideTelegram(): boolean {
  return Boolean(telegramWebApp()?.initData);
}

export function getDemoIdentity(): DemoIdentity {
  const saved = window.localStorage.getItem('telebid:demo-user');
  return demoIdentities.find((identity) => identity.id === saved) ?? demoIdentities[0]!;
}

export function setDemoIdentity(identity: DemoIdentity): void {
  window.localStorage.setItem('telebid:demo-user', identity.id);
}

export function telegramAuthHeaders(): Record<string, string> {
  const initData = telegramWebApp()?.initData;
  if (initData) return { Authorization: `tma ${initData}` };
  const demo = getDemoIdentity();
  return { 'X-Demo-User': demo.id, 'X-Demo-Name': encodeURIComponent(demo.name) };
}

export function telegramSocketAuth(): Record<string, string> {
  const initData = telegramWebApp()?.initData;
  if (initData) return { initData };
  const demo = getDemoIdentity();
  return { demoUserId: demo.id, demoDisplayName: demo.name };
}

export function telegramHaptic(type: 'light' | 'success' | 'error'): void {
  const feedback = telegramWebApp()?.HapticFeedback;
  if (!feedback) return;
  if (type === 'light') feedback.impactOccurred('light');
  else feedback.notificationOccurred(type);
}
