import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventStreamModule } from '../sync/event-stream.module';
import { TelegramAuthModule } from '../telegram/telegram-auth.module';
import { NotificationController } from './notification.controller';
import { NotificationEntity } from './notification.entity';
import { NotificationService } from './notification.service';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationEntity]), EventStreamModule, TelegramAuthModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
