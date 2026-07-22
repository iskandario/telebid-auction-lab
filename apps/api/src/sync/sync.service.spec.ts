import type { Repository } from 'typeorm';
import type { AuctionEventEnvelope, AuctionSnapshot } from '../common/domain.types';
import type { AuctionEventEntity } from '../auction/auction-event.entity';
import type { AuctionService } from '../auction/auction.service';
import { SyncService } from './sync.service';

describe('SyncService consistent recovery boundary', () => {
  it('does not include events committed after the snapshot version', async () => {
    const snapshot = { id: 'auction', version: 1 } as AuctionSnapshot;
    const auctionService = {
      get: jest.fn().mockResolvedValue(snapshot),
    } as unknown as AuctionService;
    const service = new SyncService({} as Repository<AuctionEventEntity>, auctionService);
    const events = [
      { aggregateVersion: 1, eventId: 'event-1' },
      { aggregateVersion: 2, eventId: 'event-2' },
    ] as AuctionEventEnvelope[];
    jest.spyOn(service, 'eventsAfter').mockResolvedValue(events);

    const response = await service.sync('auction', 0, 'replay');

    expect(response.mode).toBe('events');
    if (response.mode === 'events') {
      expect(response.serverVersion).toBe(1);
      expect(response.events.map((event) => event.aggregateVersion)).toEqual([1]);
    }
  });
});
