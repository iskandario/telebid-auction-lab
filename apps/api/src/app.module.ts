import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuctionModule } from './auction/auction.module';
import { EventStreamModule } from './sync/event-stream.module';
import { ExperimentModule } from './experiment/experiment.module';
import { HealthController } from './health.controller';
import { NotificationModule } from './notification/notification.module';
import { SyncModule } from './sync/sync.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL') ?? 'postgres://telebid:telebid@localhost:5440/telebid',
        autoLoadEntities: true,
        synchronize: true,
        logging: false,
      }),
    }),
    EventStreamModule,
    ExperimentModule,
    NotificationModule,
    AuctionModule,
    SyncModule,
    TelegramModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
