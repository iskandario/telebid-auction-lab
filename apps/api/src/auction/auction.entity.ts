import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { AuctionKind, AuctionStatus } from '../common/domain.types';
import { numericTransformer } from '../common/numeric.transformer';

@Entity({ name: 'auctions' })
export class AuctionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: AuctionKind })
  kind: AuctionKind;

  @Column({ length: 140 })
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ name: 'owner_id', length: 80 })
  ownerId: string;

  @Column({ name: 'owner_display_name', length: 140, default: 'Telegram user' })
  ownerDisplayName: string;

  @Column({ length: 80, default: 'Другое' })
  category: string;

  @Column({ name: 'placement_format', length: 100, default: 'Нативный пост' })
  placementFormat: string;

  @Column({ name: 'placement_at', type: 'timestamptz', nullable: true })
  placementAt: Date | null;

  @Column({ name: 'channel_username', type: 'varchar', length: 80, nullable: true })
  channelUsername: string | null;

  @Column({ name: 'channel_title', type: 'varchar', length: 140, nullable: true })
  channelTitle: string | null;

  @Column({ name: 'channel_subscribers', type: 'integer', nullable: true })
  channelSubscribers: number | null;

  @Column({ name: 'published_chat_id', type: 'varchar', length: 80, nullable: true })
  publishedChatId: string | null;

  @Column({ name: 'published_message_id', type: 'varchar', length: 80, nullable: true })
  publishedMessageId: string | null;

  @Column({ type: 'enum', enum: AuctionStatus, default: AuctionStatus.ACTIVE })
  status: AuctionStatus;

  @Column({ name: 'starting_price', type: 'numeric', precision: 14, scale: 2, transformer: numericTransformer })
  startingPrice: number;

  @Column({ name: 'current_price', type: 'numeric', precision: 14, scale: 2, transformer: numericTransformer })
  currentPrice: number;

  @Column({ name: 'min_step', type: 'numeric', precision: 14, scale: 2, transformer: numericTransformer })
  minStep: number;

  @Column({ name: 'leader_id', type: 'varchar', length: 80, nullable: true })
  leaderId: string | null;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt: Date;

  @Column({ name: 'aggregate_version', type: 'integer', default: 0 })
  aggregateVersion: number;

  @Column({ name: 'anti_sniping_window_sec', type: 'integer', default: 15 })
  antiSnipingWindowSec: number;

  @Column({ name: 'extension_sec', type: 'integer', default: 30 })
  extensionSec: number;

  @VersionColumn({ name: 'row_version' })
  rowVersion: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
