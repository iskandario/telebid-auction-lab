import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { RecoveryStrategy } from '../common/domain.types';
import { NotificationService } from '../notification/notification.service';
import { EventStreamService } from './event-stream.service';
import { SyncService } from './sync.service';
import { TelegramAuthService } from '../telegram/telegram-auth.service';

interface AuctionSubscription {
  auctionId: string;
  lastAppliedVersion: number;
  strategy: RecoveryStrategy;
  requestId?: string;
}

@WebSocketGateway({
  namespace: '/sync',
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
})
export class SyncGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly syncService: SyncService,
    private readonly notifications: NotificationService,
    private readonly stream: EventStreamService,
    private readonly telegramAuth: TelegramAuthService,
  ) {}

  afterInit(): void {
    this.stream.allAuctionEvents().subscribe((event) => {
      this.server.to(`auction:${event.auctionId}`).emit('auction:event', event);
    });
    this.stream.allNotifications().subscribe((notification) => {
      this.server
        .to(`recipient:${notification.recipientId}`)
        .emit('notification:event', notification);
    });
  }

  @SubscribeMessage('subscribe:auction')
  async subscribeAuction(
    @MessageBody() data: AuctionSubscription,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    await client.join(`auction:${data.auctionId}`);
    client.emit('sync:begin', { requestId: data.requestId, auctionId: data.auctionId });
    const payload = await this.syncService.sync(
      data.auctionId,
      Math.max(0, Number(data.lastAppliedVersion) || 0),
      data.strategy ?? 'hybrid',
    );
    client.emit('sync:payload', { requestId: data.requestId, auctionId: data.auctionId, payload });
    client.emit('sync:complete', {
      requestId: data.requestId,
      auctionId: data.auctionId,
      serverVersion: payload.serverVersion,
    });
  }

  @SubscribeMessage('subscribe:notifications')
  async subscribeNotifications(
    @MessageBody() data: { recipientId: string; afterSequence?: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      const handshake = client.handshake.auth as Record<string, string | undefined>;
      const identity = this.telegramAuth.resolve(
        handshake.initData ? `tma ${handshake.initData}` : undefined,
        handshake.demoUserId,
        handshake.demoDisplayName,
      );
      await client.join(`recipient:${identity.id}`);
      const notifications = await this.notifications.list(identity.id, data.afterSequence ?? '0');
      client.emit('notifications:sync', { recipientId: identity.id, notifications });
    } catch (error) {
      client.emit('auth:error', {
        message: error instanceof Error ? error.message : 'Telegram authentication failed',
      });
    }
  }

  @SubscribeMessage('unsubscribe:auction')
  async unsubscribeAuction(
    @MessageBody() data: { auctionId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    await client.leave(`auction:${data.auctionId}`);
  }
}
