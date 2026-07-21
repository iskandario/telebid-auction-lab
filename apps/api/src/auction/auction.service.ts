import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import {
  AuctionEventEnvelope,
  AuctionKind,
  AuctionSnapshot,
  AuctionStatus,
  NotificationView,
} from '../common/domain.types';
import { NotificationEntity } from '../notification/notification.entity';
import { NotificationService } from '../notification/notification.service';
import { EventStreamService } from '../sync/event-stream.service';
import { AuctionEventEntity } from './auction-event.entity';
import { AuctionEntity } from './auction.entity';
import { assertBidIsBetter, shouldExtendAuction } from './auction.rules';
import { BidEntity } from './bid.entity';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { ProcessedCommandEntity } from './processed-command.entity';

interface CommandResult {
  auction: AuctionSnapshot;
  events: AuctionEventEnvelope[];
  notifications: NotificationView[];
  idempotentReplay: boolean;
}

@Injectable()
export class AuctionService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AuctionEntity)
    private readonly auctions: Repository<AuctionEntity>,
    @InjectRepository(BidEntity)
    private readonly bids: Repository<BidEntity>,
    private readonly stream: EventStreamService,
    private readonly notificationService: NotificationService,
  ) {}

  async list(): Promise<AuctionSnapshot[]> {
    const auctions = await this.auctions.find({ order: { createdAt: 'DESC' } });
    return auctions.map((auction) => this.toSnapshot(auction));
  }

  async get(id: string): Promise<AuctionSnapshot> {
    return this.toSnapshot(await this.getEntity(id));
  }

  async listBids(id: string): Promise<BidEntity[]> {
    await this.getEntity(id);
    return this.bids.find({ where: { auctionId: id }, order: { acceptedAt: 'DESC' }, take: 100 });
  }

  async create(dto: CreateAuctionDto): Promise<AuctionSnapshot> {
    if (!dto.ownerId) throw new BadRequestException('Владелец аукциона не определён');
    const ownerId = dto.ownerId;
    const now = new Date();
    const correlationId = randomUUID();
    const result = await this.dataSource.transaction(async (manager) => {
      const auction = manager.getRepository(AuctionEntity).create({
        kind: dto.kind,
        title: dto.title,
        description: dto.description ?? '',
        ownerId,
        ownerDisplayName: dto.ownerDisplayName ?? ownerId,
        category: dto.category ?? 'Другое',
        placementFormat: dto.placementFormat ?? 'Нативный пост',
        placementAt: dto.placementAt ? new Date(dto.placementAt) : null,
        channelUsername: dto.channelUsername?.trim() || null,
        channelTitle: dto.channelTitle?.trim() || null,
        channelSubscribers: dto.channelSubscribers ?? null,
        publishedChatId: null,
        publishedMessageId: null,
        status: AuctionStatus.ACTIVE,
        startingPrice: dto.startingPrice,
        currentPrice: dto.startingPrice,
        minStep: dto.minStep,
        leaderId: null,
        endsAt: new Date(now.getTime() + dto.durationSeconds * 1000),
        aggregateVersion: 1,
        antiSnipingWindowSec: dto.antiSnipingWindowSec ?? 15,
        extensionSec: dto.extensionSec ?? 30,
      });
      const savedAuction = await manager.getRepository(AuctionEntity).save(auction);
      const snapshot = this.toSnapshot(savedAuction);
      const event = await manager.getRepository(AuctionEventEntity).save(
        manager.getRepository(AuctionEventEntity).create({
          auctionId: savedAuction.id,
          aggregateVersion: 1,
          type: 'AUCTION_CREATED',
          serverTimestamp: now,
          correlationId,
          payload: snapshot as unknown as Record<string, unknown>,
          schemaVersion: 1,
        }),
      );
      return { snapshot, event: this.toEnvelope(event) };
    });

    this.stream.publishAuctionEvent(result.event);
    return result.snapshot;
  }

  async placeBid(auctionId: string, dto: PlaceBidDto): Promise<CommandResult> {
    if (!dto.participantId) throw new BadRequestException('Участник не определён');
    const participantId = dto.participantId;
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const auction = await manager
        .getRepository(AuctionEntity)
        .createQueryBuilder('auction')
        .setLock('pessimistic_write')
        .where('auction.id = :auctionId', { auctionId })
        .getOne();

      if (!auction) throw new NotFoundException('Аукцион не найден');

      const processedRepository = manager.getRepository(ProcessedCommandEntity);
      const processed = await processedRepository.findOne({ where: { commandId: dto.commandId } });
      if (processed) {
        return {
          result: { ...(processed.response as unknown as CommandResult), idempotentReplay: true },
          persistedEvents: [] as AuctionEventEntity[],
          persistedNotifications: [] as NotificationEntity[],
        };
      }

      const now = new Date();
      if (auction.status !== AuctionStatus.ACTIVE || auction.endsAt.getTime() <= now.getTime()) {
        throw new BadRequestException('Торги уже завершены');
      }
      if (auction.ownerId === participantId) {
        throw new BadRequestException('Владелец не может участвовать в собственном аукционе');
      }

      assertBidIsBetter(auction.kind, auction.currentPrice, auction.minStep, dto.amount);

      const previousLeaderId = auction.leaderId;
      const previousEndsAt = auction.endsAt;
      const bidVersion = auction.aggregateVersion + 1;
      const extended = shouldExtendAuction(
        auction.endsAt,
        now,
        auction.antiSnipingWindowSec,
        auction.extensionSec,
      );

      auction.currentPrice = dto.amount;
      auction.leaderId = participantId;
      auction.aggregateVersion = bidVersion + (extended ? 1 : 0);
      if (extended) {
        auction.endsAt = new Date(auction.endsAt.getTime() + auction.extensionSec * 1000);
      }

      await manager.getRepository(AuctionEntity).save(auction);
      await manager.getRepository(BidEntity).save(
        manager.getRepository(BidEntity).create({
          auction,
          auctionId: auction.id,
          participantId,
          amount: dto.amount,
          commandId: dto.commandId,
        }),
      );

      const eventRepository = manager.getRepository(AuctionEventEntity);
      const eventEntities: AuctionEventEntity[] = [
        eventRepository.create({
          auctionId: auction.id,
          aggregateVersion: bidVersion,
          type: 'BID_ACCEPTED',
          serverTimestamp: now,
          correlationId: dto.commandId,
          payload: {
            amount: dto.amount,
            leaderId: participantId,
            previousLeaderId,
            endsAt: previousEndsAt.toISOString(),
          },
          schemaVersion: 1,
        }),
      ];

      if (extended) {
        eventEntities.push(
          eventRepository.create({
            auctionId: auction.id,
            aggregateVersion: bidVersion + 1,
            type: 'AUCTION_EXTENDED',
            serverTimestamp: now,
            correlationId: dto.commandId,
            payload: { endsAt: auction.endsAt.toISOString(), extensionSec: auction.extensionSec },
            schemaVersion: 1,
          }),
        );
      }

      const persistedEvents = await eventRepository.save(eventEntities);
      const persistedNotifications = await this.createBidNotifications(
        manager.getRepository(NotificationEntity),
        auction,
        persistedEvents,
        participantId,
        previousLeaderId,
      );

      const result: CommandResult = {
        auction: this.toSnapshot(auction),
        events: persistedEvents.map((event) => this.toEnvelope(event)),
        notifications: persistedNotifications.map((notification) =>
          this.notificationService.toView(notification),
        ),
        idempotentReplay: false,
      };

      await processedRepository.save(
        processedRepository.create({
          commandId: dto.commandId,
          auctionId,
          response: result as unknown as Record<string, unknown>,
        }),
      );

      return { result, persistedEvents, persistedNotifications };
    });

    transactionResult.persistedEvents
      .map((event) => this.toEnvelope(event))
      .forEach((event) => this.stream.publishAuctionEvent(event));
    this.notificationService.publish(transactionResult.persistedNotifications);
    return transactionResult.result;
  }

  async close(auctionId: string, force = false): Promise<AuctionSnapshot> {
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const auction = await manager
        .getRepository(AuctionEntity)
        .createQueryBuilder('auction')
        .setLock('pessimistic_write')
        .where('auction.id = :auctionId', { auctionId })
        .getOne();
      if (!auction) throw new NotFoundException('Аукцион не найден');
      if (auction.status === AuctionStatus.CLOSED) {
        return { auction, event: null, notifications: [] as NotificationEntity[] };
      }
      if (!force && auction.endsAt.getTime() > Date.now()) {
        throw new BadRequestException('Дедлайн ещё не наступил');
      }

      auction.status = AuctionStatus.CLOSED;
      auction.aggregateVersion += 1;
      await manager.getRepository(AuctionEntity).save(auction);

      const event = await manager.getRepository(AuctionEventEntity).save(
        manager.getRepository(AuctionEventEntity).create({
          auctionId,
          aggregateVersion: auction.aggregateVersion,
          type: 'AUCTION_CLOSED',
          serverTimestamp: new Date(),
          correlationId: randomUUID(),
          payload: {
            status: auction.status,
            winnerId: auction.leaderId,
            currentPrice: auction.currentPrice,
          },
          schemaVersion: 1,
        }),
      );

      const notifications = await this.createCloseNotifications(
        manager.getRepository(NotificationEntity),
        auction,
        event,
      );
      return { auction, event, notifications };
    });

    if (transactionResult.event) {
      this.stream.publishAuctionEvent(this.toEnvelope(transactionResult.event));
      this.notificationService.publish(transactionResult.notifications);
    }
    return this.toSnapshot(transactionResult.auction);
  }

  async closeDueAuctions(): Promise<void> {
    const due = await this.auctions.find({
      where: { status: AuctionStatus.ACTIVE, endsAt: LessThanOrEqual(new Date()) },
      select: { id: true },
      take: 100,
    });
    await Promise.allSettled(due.map((auction) => this.close(auction.id)));
  }

  async markPublished(
    auctionId: string,
    ownerId: string,
    publication: {
      chatId: string;
      messageId: string;
      channelUsername: string;
      channelTitle?: string;
    },
  ): Promise<AuctionSnapshot> {
    const auction = await this.getEntity(auctionId);
    if (auction.ownerId !== ownerId) throw new BadRequestException('Опубликовать лот может только владелец');
    auction.publishedChatId = publication.chatId;
    auction.publishedMessageId = publication.messageId;
    auction.channelUsername = publication.channelUsername;
    if (publication.channelTitle) auction.channelTitle = publication.channelTitle;
    return this.toSnapshot(await this.auctions.save(auction));
  }

  toSnapshot(auction: AuctionEntity): AuctionSnapshot {
    return {
      id: auction.id,
      kind: auction.kind,
      title: auction.title,
      description: auction.description,
      ownerId: auction.ownerId,
      ownerDisplayName: auction.ownerDisplayName,
      status: auction.status,
      category: auction.category,
      placementFormat: auction.placementFormat,
      placementAt: auction.placementAt?.toISOString() ?? null,
      channelUsername: auction.channelUsername,
      channelTitle: auction.channelTitle,
      channelSubscribers: auction.channelSubscribers,
      publishedChatId: auction.publishedChatId,
      publishedMessageId: auction.publishedMessageId,
      startingPrice: auction.startingPrice,
      currentPrice: auction.currentPrice,
      minStep: auction.minStep,
      leaderId: auction.leaderId,
      endsAt: auction.endsAt.toISOString(),
      version: auction.aggregateVersion,
    };
  }

  toEnvelope(event: AuctionEventEntity): AuctionEventEnvelope {
    return {
      eventId: event.eventId,
      auctionId: event.auctionId,
      aggregateVersion: event.aggregateVersion,
      type: event.type,
      serverTimestamp: event.serverTimestamp.toISOString(),
      correlationId: event.correlationId,
      payload: event.payload,
      schemaVersion: 1,
    };
  }

  private async getEntity(id: string): Promise<AuctionEntity> {
    const auction = await this.auctions.findOne({ where: { id } });
    if (!auction) throw new NotFoundException('Аукцион не найден');
    return auction;
  }

  private async createBidNotifications(
    repository: Repository<NotificationEntity>,
    auction: AuctionEntity,
    events: AuctionEventEntity[],
    participantId: string,
    previousLeaderId: string | null,
  ): Promise<NotificationEntity[]> {
    const bidEvent = events.find((event) => event.type === 'BID_ACCEPTED');
    if (!bidEvent) return [];

    const specifications: Array<{ recipientId: string; kind: string; message: string; event: AuctionEventEntity }> = [];
    if (auction.ownerId !== participantId) {
      specifications.push({
        recipientId: auction.ownerId,
        kind: 'NEW_PROPOSAL',
        message: `Новое предложение ${auction.currentPrice} ₽ в «${auction.title}»`,
        event: bidEvent,
      });
    }
    specifications.push({
      recipientId: participantId,
      kind: 'LEADING',
      message: `Ваше предложение лидирует в «${auction.title}»`,
      event: bidEvent,
    });
    if (previousLeaderId && previousLeaderId !== participantId) {
      specifications.push({
        recipientId: previousLeaderId,
        kind: 'OUTBID',
        message: `Ваше предложение больше не лидирует в «${auction.title}»`,
        event: bidEvent,
      });
    }

    const extensionEvent = events.find((event) => event.type === 'AUCTION_EXTENDED');
    if (extensionEvent) {
      for (const recipientId of new Set([auction.ownerId, participantId])) {
        specifications.push({
          recipientId,
          kind: 'DEADLINE_EXTENDED',
          message: `Торги «${auction.title}» продлены до ${auction.endsAt.toLocaleTimeString('ru-RU')}`,
          event: extensionEvent,
        });
      }
    }

    return repository.save(
      specifications.map((specification) =>
        repository.create({
          notificationId: randomUUID(),
          recipientId: specification.recipientId,
          auctionId: auction.id,
          eventId: specification.event.eventId,
          aggregateVersion: specification.event.aggregateVersion,
          kind: specification.kind,
          message: specification.message,
          dedupeKey: `${specification.recipientId}:${specification.event.eventId}:${specification.kind}`,
          readAt: null,
          telegramStatus: 'PENDING',
          telegramDeliveredAt: null,
          telegramAttempts: 0,
          telegramLastError: null,
        }),
      ),
    );
  }

  private async createCloseNotifications(
    repository: Repository<NotificationEntity>,
    auction: AuctionEntity,
    event: AuctionEventEntity,
  ): Promise<NotificationEntity[]> {
    const specifications = [
      {
        recipientId: auction.ownerId,
        kind: 'AUCTION_CLOSED',
        message: `Торги «${auction.title}» завершены. Победитель: ${auction.leaderId ?? 'нет'}`,
      },
    ];
    if (auction.leaderId) {
      specifications.push({
        recipientId: auction.leaderId,
        kind: 'AUCTION_WON',
        message: `Вы победили в «${auction.title}» с предложением ${auction.currentPrice} ₽`,
      });
    }
    return repository.save(
      specifications.map((specification) =>
        repository.create({
          notificationId: randomUUID(),
          recipientId: specification.recipientId,
          auctionId: auction.id,
          eventId: event.eventId,
          aggregateVersion: event.aggregateVersion,
          kind: specification.kind,
          message: specification.message,
          dedupeKey: `${specification.recipientId}:${event.eventId}:${specification.kind}`,
          readAt: null,
          telegramStatus: 'PENDING',
          telegramDeliveredAt: null,
          telegramAttempts: 0,
          telegramLastError: null,
        }),
      ),
    );
  }
}
