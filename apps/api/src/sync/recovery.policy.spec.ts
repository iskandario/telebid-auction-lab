import { AuctionKind, AuctionStatus } from '../common/domain.types';
import { selectRecovery } from './recovery.policy';

const snapshot = {
  id: 'auction',
  kind: AuctionKind.DIRECT,
  title: 'Slot',
  description: '',
  ownerId: 'owner',
  ownerDisplayName: 'Owner',
  status: AuctionStatus.ACTIVE,
  category: 'Tech',
  placementFormat: 'Post',
  placementAt: null,
  channelUsername: null,
  channelTitle: null,
  channelSubscribers: null,
  publishedChatId: null,
  publishedMessageId: null,
  startingPrice: 100,
  currentPrice: 100,
  minStep: 10,
  leaderId: 'u1',
  endsAt: '2026-07-21T10:00:00.000Z',
  version: 2,
};

const event = {
  eventId: 'event',
  auctionId: 'auction',
  aggregateVersion: 2,
  type: 'BID_ACCEPTED' as const,
  serverTimestamp: '2026-07-21T09:00:00.000Z',
  correlationId: 'command',
  payload: { amount: 100 },
  schemaVersion: 1 as const,
};

describe('recovery policy', () => {
  it('returns events for explicit replay with a continuous journal', () => {
    expect(selectRecovery('replay', snapshot, [event], 1).mode).toBe('events');
  });

  it('falls back to snapshot when replay has a version gap', () => {
    const response = selectRecovery('replay', snapshot, [], 0);
    expect(response.mode).toBe('snapshot');
    expect(response.reason).toBe('journal-gap-fallback');
  });
});
