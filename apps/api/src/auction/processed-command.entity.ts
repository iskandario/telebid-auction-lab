import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'processed_commands' })
export class ProcessedCommandEntity {
  @PrimaryColumn({ name: 'auction_id', type: 'uuid' })
  auctionId: string;

  @PrimaryColumn({ name: 'command_id', type: 'uuid' })
  commandId: string;

  @Column({ type: 'jsonb' })
  response: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
