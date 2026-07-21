import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'processed_commands' })
export class ProcessedCommandEntity {
  @PrimaryColumn({ name: 'command_id', type: 'uuid' })
  commandId: string;

  @Column({ name: 'auction_id', type: 'uuid' })
  auctionId: string;

  @Column({ type: 'jsonb' })
  response: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
