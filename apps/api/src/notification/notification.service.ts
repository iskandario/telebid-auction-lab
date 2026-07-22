import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import type { NotificationView } from '../common/domain.types';
import { EventStreamService } from '../sync/event-stream.service';
import { NotificationEntity } from './notification.entity';

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    private readonly stream: EventStreamService,
  ) {}

  async list(recipientId: string, afterSequence = '0'): Promise<NotificationView[]> {
    const entities = await this.notifications.find({
      where: {
        recipientId,
        sequence: MoreThan(afterSequence),
      },
      order: { sequence: 'ASC' },
      take: 200,
    });
    return entities.map((entity) => this.toView(entity));
  }

  async markRead(recipientId: string, notificationId: string): Promise<void> {
    await this.notifications.update({ recipientId, notificationId }, { readAt: new Date() });
  }

  publish(entities: NotificationEntity[]): void {
    entities.forEach((entity) => this.stream.publishNotification(this.toView(entity)));
  }

  toView(entity: NotificationEntity): NotificationView {
    return {
      sequence: String(entity.sequence),
      notificationId: entity.notificationId,
      recipientId: entity.recipientId,
      auctionId: entity.auctionId,
      eventId: entity.eventId,
      aggregateVersion: entity.aggregateVersion,
      kind: entity.kind,
      message: entity.message,
      createdAt: entity.createdAt.toISOString(),
      readAt: entity.readAt?.toISOString() ?? null,
      telegramStatus: entity.telegramStatus,
      telegramDeliveredAt: entity.telegramDeliveredAt?.toISOString() ?? null,
      telegramAttempts: entity.telegramAttempts,
      telegramLastError: entity.telegramLastError,
    };
  }
}
