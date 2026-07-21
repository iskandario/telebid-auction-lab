import { Controller, Get, Headers, MessageEvent, Param, ParseUUIDPipe, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import type { AuctionEventEnvelope, RecoveryStrategy } from '../common/domain.types';
import { EventStreamService } from './event-stream.service';
import { SyncService } from './sync.service';

@ApiTags('synchronization')
@Controller('auctions/:id')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly stream: EventStreamService,
  ) {}

  @Get('sync')
  sync(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('sinceVersion') sinceVersion = '0',
    @Query('strategy') strategy: RecoveryStrategy = 'hybrid',
  ) {
    return this.syncService.sync(id, this.parseVersion(sinceVersion), this.parseStrategy(strategy));
  }

  @Sse('events')
  events(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('sinceVersion') queryVersion = '0',
  ): Observable<MessageEvent> {
    const cursor = this.parseVersion(lastEventId ?? queryVersion);
    return new Observable<MessageEvent>((subscriber) => {
      let ready = false;
      const buffered: AuctionEventEnvelope[] = [];
      const emitted = new Set<number>();
      const subscription = this.stream.auctionEvents(id).subscribe((event) => {
        if (!ready) buffered.push(event);
        else this.emitEvent(subscriber, event, cursor, emitted);
      });

      void this.syncService
        .eventsAfter(id, cursor)
        .then((initial) => {
          [...initial, ...buffered]
            .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
            .forEach((event) => this.emitEvent(subscriber, event, cursor, emitted));
          ready = true;
        })
        .catch((error) => subscriber.error(error));

      return () => subscription.unsubscribe();
    });
  }

  private emitEvent(
    subscriber: { next: (event: MessageEvent) => void },
    event: AuctionEventEnvelope,
    cursor: number,
    emitted: Set<number>,
  ): void {
    if (event.aggregateVersion <= cursor || emitted.has(event.aggregateVersion)) return;
    emitted.add(event.aggregateVersion);
    subscriber.next({
      id: String(event.aggregateVersion),
      type: event.type,
      data: event,
      retry: 1000,
    });
  }

  private parseVersion(value: string): number {
    const version = Number(value);
    return Number.isInteger(version) && version >= 0 ? version : 0;
  }

  private parseStrategy(value: string): RecoveryStrategy {
    return value === 'snapshot' || value === 'replay' || value === 'hybrid' ? value : 'hybrid';
  }
}
