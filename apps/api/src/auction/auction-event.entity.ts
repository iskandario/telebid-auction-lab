import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { AuctionEventType } from '../common/domain.types';

@Entity({ name: 'auction_events' })
@Unique('uq_auction_event_version', ['auctionId', 'aggregateVersion'])
export class AuctionEventEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'event_id' })
  eventId: string;

  @Column({ name: 'auction_id', type: 'uuid' })
  @Index()
  auctionId: string;

  @Column({ name: 'aggregate_version', type: 'integer' })
  aggregateVersion: number;

  @Column({ type: 'varchar', length: 40 })
  type: AuctionEventType;

  @Column({ name: 'server_timestamp', type: 'timestamptz' })
  serverTimestamp: Date;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'schema_version', type: 'integer', default: 1 })
  schemaVersion: number;
}
