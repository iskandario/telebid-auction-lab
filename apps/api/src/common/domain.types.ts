export enum AuctionKind {
  DIRECT = 'DIRECT',
  REVERSE = 'REVERSE',
}

export enum AuctionStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

export type RecoveryStrategy = 'snapshot' | 'replay' | 'hybrid';

export type AuctionEventType =
  | 'AUCTION_CREATED'
  | 'BID_ACCEPTED'
  | 'AUCTION_EXTENDED'
  | 'AUCTION_CLOSED';

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
  type: AuctionEventType;
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
