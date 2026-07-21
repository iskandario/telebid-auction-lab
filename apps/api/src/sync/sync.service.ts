import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import type { AuctionEventEnvelope, RecoveryStrategy, SyncResponse } from '../common/domain.types';
import { AuctionEventEntity } from '../auction/auction-event.entity';
import { AuctionService } from '../auction/auction.service';
import { selectRecovery } from './recovery.policy';

@Injectable()
export class SyncService {
  constructor(
    @InjectRepository(AuctionEventEntity)
    private readonly events: Repository<AuctionEventEntity>,
    private readonly auctions: AuctionService,
  ) {}

  async sync(
    auctionId: string,
    sinceVersion: number,
    strategy: RecoveryStrategy,
  ): Promise<SyncResponse> {
    const [snapshot, events] = await Promise.all([
      this.auctions.get(auctionId),
      this.eventsAfter(auctionId, sinceVersion),
    ]);
    return selectRecovery(strategy, snapshot, events, sinceVersion);
  }

  async eventsAfter(auctionId: string, sinceVersion: number): Promise<AuctionEventEnvelope[]> {
    const entities = await this.events.find({
      where: { auctionId, aggregateVersion: MoreThan(sinceVersion) },
      order: { aggregateVersion: 'ASC' },
      take: 1000,
    });
    return entities.map((event) => this.auctions.toEnvelope(event));
  }
}
