import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'notifications' })
export class NotificationEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  sequence: string;

  @Column({ name: 'notification_id', type: 'uuid', unique: true })
  notificationId: string;

  @Column({ name: 'recipient_id', length: 80 })
  @Index()
  recipientId: string;

  @Column({ name: 'auction_id', type: 'uuid' })
  auctionId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'aggregate_version', type: 'integer' })
  aggregateVersion: number;

  @Column({ length: 40 })
  kind: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'dedupe_key', length: 220, unique: true })
  dedupeKey: string;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ name: 'telegram_status', length: 20, default: 'PENDING' })
  telegramStatus: string;

  @Column({ name: 'telegram_delivered_at', type: 'timestamptz', nullable: true })
  telegramDeliveredAt: Date | null;

  @Column({ name: 'telegram_attempts', type: 'integer', default: 0 })
  telegramAttempts: number;

  @Column({ name: 'telegram_last_error', type: 'text', nullable: true })
  telegramLastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
