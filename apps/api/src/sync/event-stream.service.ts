import { Injectable } from '@nestjs/common';
import { filter, Observable, Subject } from 'rxjs';
import type { AuctionEventEnvelope, NotificationView } from '../common/domain.types';

@Injectable()
export class EventStreamService {
  private readonly auctionSubject = new Subject<AuctionEventEnvelope>();
  private readonly notificationSubject = new Subject<NotificationView>();

  publishAuctionEvent(event: AuctionEventEnvelope): void {
    this.auctionSubject.next(event);
  }

  publishNotification(notification: NotificationView): void {
    this.notificationSubject.next(notification);
  }

  auctionEvents(auctionId: string): Observable<AuctionEventEnvelope> {
    return this.auctionSubject.pipe(filter((event) => event.auctionId === auctionId));
  }

  allAuctionEvents(): Observable<AuctionEventEnvelope> {
    return this.auctionSubject.asObservable();
  }

  notifications(recipientId: string): Observable<NotificationView> {
    return this.notificationSubject.pipe(
      filter((notification) => notification.recipientId === recipientId),
    );
  }

  allNotifications(): Observable<NotificationView> {
    return this.notificationSubject.asObservable();
  }
}
