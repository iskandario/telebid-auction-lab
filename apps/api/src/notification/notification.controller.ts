import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  MessageEvent,
  Param,
  Patch,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import type { NotificationView } from '../common/domain.types';
import { EventStreamService } from '../sync/event-stream.service';
import { TelegramAuthService } from '../telegram/telegram-auth.service';
import { NotificationService } from './notification.service';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly stream: EventStreamService,
    private readonly telegramAuth: TelegramAuthService,
  ) {}

  @Get(':recipientId')
  list(
    @Param('recipientId') recipientId: string,
    @Query('afterSequence') after = '0',
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    this.assertRecipient(recipientId, authorization, demoUserId, demoDisplayName);
    return this.notifications.list(recipientId, after);
  }

  @Sse(':recipientId/stream')
  events(
    @Param('recipientId') recipientId: string,
    @Query('afterSequence') after = '0',
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ): Observable<MessageEvent> {
    this.assertRecipient(recipientId, authorization, demoUserId, demoDisplayName);
    return new Observable<MessageEvent>((subscriber) => {
      let ready = false;
      const buffered: NotificationView[] = [];
      const emitted = new Set<string>();
      const subscription = this.stream.notifications(recipientId).subscribe((notification) => {
        if (!ready) buffered.push(notification);
        else this.emitNotification(subscriber, notification, after, emitted);
      });

      void this.notifications
        .list(recipientId, after)
        .then((initial) => {
          [...initial, ...buffered]
            .sort((left, right) => Number(left.sequence) - Number(right.sequence))
            .forEach((notification) =>
              this.emitNotification(subscriber, notification, after, emitted),
            );
          ready = true;
        })
        .catch((error) => subscriber.error(error));

      return () => subscription.unsubscribe();
    });
  }

  @Patch(':recipientId/:notificationId/read')
  async markRead(
    @Param('recipientId') recipientId: string,
    @Param('notificationId') notificationId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-demo-user') demoUserId?: string,
    @Headers('x-demo-name') demoDisplayName?: string,
  ) {
    this.assertRecipient(recipientId, authorization, demoUserId, demoDisplayName);
    await this.notifications.markRead(recipientId, notificationId);
    return { ok: true };
  }

  private assertRecipient(
    recipientId: string,
    authorization?: string,
    demoUserId?: string,
    demoDisplayName?: string,
  ): void {
    const identity = this.telegramAuth.resolve(authorization, demoUserId, demoDisplayName);
    if (identity.id !== recipientId) {
      throw new ForbiddenException('Можно читать только собственные уведомления');
    }
  }

  private emitNotification(
    subscriber: { next: (event: MessageEvent) => void },
    notification: NotificationView,
    after: string,
    emitted: Set<string>,
  ): void {
    if (Number(notification.sequence) <= Number(after) || emitted.has(notification.notificationId)) return;
    emitted.add(notification.notificationId);
    subscriber.next({
      id: notification.sequence,
      type: notification.kind,
      data: notification,
      retry: 1000,
    });
  }
}
