import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private readonly scheduledRetries = new Set<string>();

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    private readonly stream: EventStreamService,
    private readonly api: TelegramApiService,
    private readonly bot: TelegramBotService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.stream.allNotifications().subscribe((notification) => {
      void this.deliver(notification.notificationId);
    });
    void this.retryPending();
  }

  @Interval(15000)
  async retryPending(): Promise<void> {
    if (!this.api.isDeliveryConfigured()) return;
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
    if (!this.api.isDeliveryConfigured() || this.delivering.has(notificationId)) return;
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
        const attempts = notification.telegramAttempts + 1;
        await this.notifications.update(
          { notificationId },
          {
            telegramStatus: 'FAILED',
            telegramAttempts: attempts,
            telegramLastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          },
        );
        if (attempts < 5) this.scheduleRetry(notificationId, attempts);
      }
    } finally {
      this.delivering.delete(notificationId);
    }
  }

  private scheduleRetry(notificationId: string, attempts: number): void {
    if (this.scheduledRetries.has(notificationId)) return;
    this.scheduledRetries.add(notificationId);
    const baseDelayMs = Math.max(
      10,
      Number(this.config.get<string>('TELEGRAM_RETRY_BASE_DELAY_MS') ?? 1000),
    );
    const timer = setTimeout(() => {
      this.scheduledRetries.delete(notificationId);
      void this.deliver(notificationId);
    }, baseDelayMs * 2 ** Math.max(0, attempts - 1));
    timer.unref?.();
  }
}
