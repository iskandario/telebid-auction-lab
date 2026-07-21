import { BadRequestException } from '@nestjs/common';
import { AuctionKind } from '../common/domain.types';

export function assertBidIsBetter(
  kind: AuctionKind,
  currentPrice: number,
  minStep: number,
  amount: number,
): void {
  const threshold = kind === AuctionKind.DIRECT ? currentPrice + minStep : currentPrice - minStep;
  const valid = kind === AuctionKind.DIRECT ? amount >= threshold : amount <= threshold && amount > 0;

  if (!valid) {
    const direction = kind === AuctionKind.DIRECT ? 'не меньше' : 'не больше';
    throw new BadRequestException(`Предложение должно быть ${direction} ${threshold}`);
  }
}
export function shouldExtendAuction(
  endsAt: Date,
  now: Date,
  antiSnipingWindowSec: number,
  extensionSec: number,
): boolean {
  const remainingMs = endsAt.getTime() - now.getTime();
  return extensionSec > 0 && remainingMs >= 0 && remainingMs <= antiSnipingWindowSec * 1000;
}
