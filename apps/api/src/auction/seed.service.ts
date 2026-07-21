import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuctionKind } from '../common/domain.types';
import { AuctionEntity } from './auction.entity';
import { AuctionService } from './auction.service';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(AuctionEntity)
    private readonly repository: Repository<AuctionEntity>,
    private readonly auctions: AuctionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if ((await this.repository.count()) > 0) return;

    await this.auctions.create({
      kind: AuctionKind.DIRECT,
      title: 'Рекламный слот в Telegram, 120 000 подписчиков',
      description: 'Нативный пост 24 часа. Тематика: технологии и образование.',
      ownerId: 'demo-owner',
      ownerDisplayName: 'Анна · TechFlow',
      category: 'Технологии',
      placementFormat: 'Нативный пост на 24 часа',
      placementAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      channelUsername: '@techflow_demo',
      channelTitle: 'TechFlow',
      channelSubscribers: 120000,
      startingPrice: 25000,
      minStep: 1000,
      durationSeconds: 3600,
      antiSnipingWindowSec: 15,
      extensionSec: 30,
    });

    await this.auctions.create({
      kind: AuctionKind.REVERSE,
      title: 'Кампания запуска приложения для учёта финансов',
      description: 'Ищем блогера с аудиторией 18–30 лет. Формат: видео до 60 секунд.',
      ownerId: 'demo-advertiser',
      ownerDisplayName: 'FinUp',
      category: 'Финансы',
      placementFormat: 'Нативный пост или видео до 60 секунд',
      placementAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      channelUsername: undefined,
      channelTitle: undefined,
      channelSubscribers: 30000,
      startingPrice: 80000,
      minStep: 2000,
      durationSeconds: 3600,
      antiSnipingWindowSec: 15,
      extensionSec: 30,
    });
  }
}
