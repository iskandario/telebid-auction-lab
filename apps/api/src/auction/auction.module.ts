import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationModule } from '../notification/notification.module';
import { EventStreamModule } from '../sync/event-stream.module';
import { AuctionCloserService } from './auction-closer.service';
import { AuctionEventEntity } from './auction-event.entity';
import { AuctionController } from './auction.controller';
import { AuctionEntity } from './auction.entity';
import { AuctionService } from './auction.service';
import { BidEntity } from './bid.entity';
import { ProcessedCommandEntity } from './processed-command.entity';
import { SeedService } from './seed.service';
import { TelegramAuthModule } from '../telegram/telegram-auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuctionEntity,
      BidEntity,
      AuctionEventEntity,
      ProcessedCommandEntity,
    ]),
    NotificationModule,
    EventStreamModule,
    TelegramAuthModule,
  ],
  controllers: [AuctionController],
  providers: [AuctionService, AuctionCloserService, SeedService],
  exports: [AuctionService],
})
export class AuctionModule {}
