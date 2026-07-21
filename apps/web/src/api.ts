import type { AuctionKind, AuctionSnapshot, NotificationView, RecoveryStrategy, SyncResponse } from './domain';
import type { ExperimentInput, ExperimentResult } from './experiment.types';
import { telegramAuthHeaders } from './telegram';

export const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8080' : '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...telegramAuthHeaders(), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function listAuctions(): Promise<AuctionSnapshot[]> {
  return request('/auctions');
}

export function createAuction(input: {
  kind: AuctionKind;
  title: string;
  description: string;
  ownerId?: string;
  ownerDisplayName?: string;
  category?: string;
  placementFormat?: string;
  placementAt?: string;
  channelUsername?: string;
  channelTitle?: string;
  channelSubscribers?: number;
  startingPrice: number;
  minStep: number;
  durationSeconds: number;
  antiSnipingWindowSec: number;
  extensionSec: number;
}): Promise<AuctionSnapshot> {
  return request('/auctions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getAuction(id: string): Promise<AuctionSnapshot> {
  return request(`/auctions/${id}`);
}

export function syncAuction(
  id: string,
  sinceVersion: number,
  strategy: RecoveryStrategy,
): Promise<SyncResponse> {
  return request(`/auctions/${id}/sync?sinceVersion=${sinceVersion}&strategy=${strategy}`);
}

export function placeBid(
  id: string,
  participantId: string,
  amount: number,
): Promise<unknown> {
  return request(`/auctions/${id}/bids`, {
    method: 'POST',
    body: JSON.stringify({ participantId, amount, commandId: crypto.randomUUID() }),
  });
}

export interface TelegramSession {
  user: {
    id: string;
    firstName: string;
    lastName?: string;
    username?: string;
    photoUrl?: string;
    displayName: string;
    source: 'telegram' | 'demo';
  };
  telegramConfigured: boolean;
  botUsername: string | null;
  miniAppUrl: string | null;
}

export function getTelegramSession(): Promise<TelegramSession> {
  return request('/telegram/session');
}

export function publishAuction(id: string, channelUsername: string): Promise<AuctionSnapshot> {
  return request(`/telegram/auctions/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ channelUsername }),
  });
}

export function listNotifications(
  recipientId: string,
  afterSequence: string,
): Promise<NotificationView[]> {
  return request(`/notifications/${encodeURIComponent(recipientId)}?afterSequence=${afterSequence}`);
}

export function runExperiment(input: ExperimentInput): Promise<ExperimentResult> {
  return request('/experiments/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
