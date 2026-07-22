import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { numericTransformer } from '../common/numeric.transformer';
import { AuctionEntity } from './auction.entity';

@Entity({ name: 'bids' })
@Unique('uq_bid_auction_command', ['auctionId', 'commandId'])
export class BidEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AuctionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'auction_id' })
  auction: AuctionEntity;

  @Column({ name: 'auction_id', type: 'uuid' })
  @Index()
  auctionId: string;

  @Column({ name: 'participant_id', length: 80 })
  participantId: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, transformer: numericTransformer })
  amount: number;

  @Column({ name: 'command_id', type: 'uuid' })
  commandId: string;

  @CreateDateColumn({ name: 'accepted_at', type: 'timestamptz' })
  acceptedAt: Date;
}
