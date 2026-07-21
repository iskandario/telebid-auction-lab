import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AuctionService } from './auction.service';

@Injectable()
export class AuctionCloserService {
  private running = false;

  constructor(private readonly auctions: AuctionService) {}

  @Interval(1000)
  async closeExpired(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.auctions.closeDueAuctions();
    } finally {
      this.running = false;
    }
  }
}
