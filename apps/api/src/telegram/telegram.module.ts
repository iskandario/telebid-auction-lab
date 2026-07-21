import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuctionModule } from '../auction/auction.module';
import { NotificationEntity } from '../notification/notification.entity';
import { EventStreamModule } from '../sync/event-stream.module';
import { TelegramApiService } from './telegram-api.service';
import { TelegramAuthModule } from './telegram-auth.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';
import { TelegramNotificationDispatcher } from './telegram-notification.dispatcher';

@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationEntity]),
    EventStreamModule,
    TelegramAuthModule,
    AuctionModule,
  ],
  controllers: [TelegramController],
  providers: [TelegramApiService, TelegramBotService, TelegramNotificationDispatcher],
  exports: [TelegramApiService, TelegramBotService],
})
export class TelegramModule {}
