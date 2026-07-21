import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuctionEventEntity } from '../auction/auction-event.entity';
import { AuctionModule } from '../auction/auction.module';
import { NotificationModule } from '../notification/notification.module';
import { EventStreamModule } from './event-stream.module';
import { SyncController } from './sync.controller';
import { SyncGateway } from './sync.gateway';
import { SyncService } from './sync.service';
import { TelegramAuthModule } from '../telegram/telegram-auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuctionEventEntity]),
    AuctionModule,
    NotificationModule,
    EventStreamModule,
    TelegramAuthModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncGateway],
  exports: [SyncService],
})
export class SyncModule {}
