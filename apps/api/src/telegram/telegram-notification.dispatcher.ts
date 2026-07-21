import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { NotificationEntity } from '../notification/notification.entity';
import { EventStreamService } from '../sync/event-stream.service';
import { TelegramApiService } from './telegram-api.service';
import { TelegramBotService } from './telegram-bot.service';

@Injectable()
export class TelegramNotificationDispatcher implements OnApplicationBootstrap {
  private readonly delivering = new Set<string>();

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    private readonly stream: EventStreamService,
    private readonly api: TelegramApiService,
    private readonly bot: TelegramBotService,
  ) {}

  onApplicationBootstrap(): void {
    this.stream.allNotifications().subscribe((notification) => {
      void this.deliver(notification.notificationId);
    });
  }

  @Interval(15000)
  async retryPending(): Promise<void> {
    if (!this.api.isConfigured()) return;
    const pending = await this.notifications.find({
      where: {
        telegramStatus: In(['PENDING', 'FAILED']),
        telegramAttempts: LessThan(5),
      },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    await Promise.allSettled(pending.map((notification) => this.deliver(notification.notificationId)));
  }

  private async deliver(notificationId: string): Promise<void> {
    if (!this.api.isConfigured() || this.delivering.has(notificationId)) return;
    this.delivering.add(notificationId);
    try {
      const notification = await this.notifications.findOne({ where: { notificationId } });
      if (!notification || notification.telegramStatus === 'DELIVERED') return;
      if (!/^\d+$/.test(notification.recipientId)) {
        await this.notifications.update({ notificationId }, { telegramStatus: 'SKIPPED' });
        return;
      }

      const miniAppUrl = await this.bot.getMiniAppUrl();
      const url = miniAppUrl ? new URL(miniAppUrl) : null;
      if (url) url.searchParams.set('auctionId', notification.auctionId);
      await this.api.sendMessage({
        chat_id: Number(notification.recipientId),
        text: notification.message,
        reply_markup: url
          ? { inline_keyboard: [[{ text: 'Открыть торги', web_app: { url: url.toString() } }]] }
          : undefined,
      });
      await this.notifications.update(
        { notificationId },
        {
          telegramStatus: 'DELIVERED',
          telegramDeliveredAt: new Date(),
          telegramAttempts: notification.telegramAttempts + 1,
          telegramLastError: null,
        },
      );
    } catch (error) {
      const notification = await this.notifications.findOne({ where: { notificationId } });
      if (notification) {
        await this.notifications.update(
          { notificationId },
          {
            telegramStatus: 'FAILED',
            telegramAttempts: notification.telegramAttempts + 1,
            telegramLastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          },
        );
      }
    } finally {
      this.delivering.delete(notificationId);
    }
  }
}
