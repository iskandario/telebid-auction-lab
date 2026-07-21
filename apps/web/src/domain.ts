export type AuctionKind = 'DIRECT' | 'REVERSE';
export type AuctionStatus = 'ACTIVE' | 'CLOSED';
export type Transport = 'polling' | 'sse' | 'websocket';
export type RecoveryStrategy = 'snapshot' | 'replay' | 'hybrid';

export interface AuctionSnapshot {
  id: string;
  kind: AuctionKind;
  title: string;
  description: string;
  ownerId: string;
  ownerDisplayName: string;
  status: AuctionStatus;
  category: string;
  placementFormat: string;
  placementAt: string | null;
  channelUsername: string | null;
  channelTitle: string | null;
  channelSubscribers: number | null;
  publishedChatId: string | null;
  publishedMessageId: string | null;
  startingPrice: number;
  currentPrice: number;
  minStep: number;
  leaderId: string | null;
  endsAt: string;
  version: number;
}

export interface AuctionEventEnvelope {
  eventId: string;
  auctionId: string;
  aggregateVersion: number;
  type: 'AUCTION_CREATED' | 'BID_ACCEPTED' | 'AUCTION_EXTENDED' | 'AUCTION_CLOSED';
  serverTimestamp: string;
  correlationId: string;
  payload: Record<string, unknown>;
  schemaVersion: 1;
}

export interface NotificationView {
  sequence: string;
  notificationId: string;
  recipientId: string;
  auctionId: string;
  eventId: string;
  aggregateVersion: number;
  kind: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  telegramStatus: string;
}

export type SyncResponse =
  | {
      mode: 'snapshot';
      strategy: RecoveryStrategy;
      reason: string;
      serverVersion: number;
      estimatedBytes: number;
      snapshot: AuctionSnapshot;
    }
  | {
      mode: 'events';
      strategy: RecoveryStrategy;
      reason: string;
      serverVersion: number;
      estimatedBytes: number;
      events: AuctionEventEnvelope[];
    };

export interface ClientMetrics {
  eventLatencyMs: number | null;
  notificationLatencyMs: number | null;
  recoveryTimeMs: number | null;
  gapCount: number;
  duplicateCount: number;
  duplicateNotificationCount: number;
  causalOrderViolationCount: number;
  lastRecoveryMode: string;
}

export function applyAuctionEvent(
  current: AuctionSnapshot | null,
  event: AuctionEventEnvelope,
): AuctionSnapshot | null {
  if (event.type === 'AUCTION_CREATED') return event.payload as unknown as AuctionSnapshot;
  if (!current) return null;

  if (event.type === 'BID_ACCEPTED') {
    return {
      ...current,
      currentPrice: Number(event.payload.amount),
      leaderId: String(event.payload.leaderId),
      endsAt: String(event.payload.endsAt),
      version: event.aggregateVersion,
    };
  }
  if (event.type === 'AUCTION_EXTENDED') {
    return { ...current, endsAt: String(event.payload.endsAt), version: event.aggregateVersion };
  }
  return {
    ...current,
    status: 'CLOSED',
    leaderId: event.payload.winnerId ? String(event.payload.winnerId) : null,
    currentPrice: Number(event.payload.currentPrice),
    version: event.aggregateVersion,
  };
}
